(() => {
  const DATABASE = "pos-checkout-offline";
  const SNAPSHOTS = "snapshots";
  const QUEUE = "saleQueue";
  const STATES = new Set(["pending", "conflict"]);
  const SNAPSHOT_KEYS = new Set(["products", "customers"]);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let opening;

  function openDatabase() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 2);
      request.onupgradeneeded = (event) => {
          const db = request.result;
        if (event.oldVersion === 0) {
          db.createObjectStore(SNAPSHOTS);
          const queue = db.createObjectStore(QUEUE, { keyPath: "sequence", autoIncrement: true });
          queue.createIndex("saleId", "id", { unique: true });
        }
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            opening = null;
          };
          db.onclose = () => { opening = null; };
          resolve(db);
        };
      }).catch((error) => {
        opening = null;
        throw error;
      });
    }
    return opening;
  }

  async function guarded(expected, run) {
    expected = saleId(expected);
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([SNAPSHOTS, QUEUE], "readwrite");
      let result, failure;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("Offline transaction was aborted"));
      const snapshots = tx.objectStore(SNAPSHOTS);
      const queue = tx.objectStore(QUEUE);
      const abort = (error) => { failure = error; tx.abort(); };
      const request = snapshots.get("storeId");
      request.onsuccess = () => {
        if (request.result !== expected) return abort(new Error("Store binding changed"));
        try { run(queue, snapshots, (value) => { result = value; }, abort); }
        catch (error) { abort(error); }
      };
    });
  }

  async function getBinding() {
    return transaction(SNAPSHOTS, "readonly", (store, setResult) => {
      const request = store.get("storeId");
      request.onsuccess = () => setResult(request.result ?? null);
    });
  }

  async function bindStore(id, { acceptLegacy = false, allowSwitch = false, expectedCurrent = null } = {}) {
    id = saleId(id);
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([SNAPSHOTS, QUEUE], "readwrite");
      let result, failure;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("Cannot bind store"));
      const snapshots = tx.objectStore(SNAPSHOTS), queue = tx.objectStore(QUEUE);
      const currentRequest = snapshots.get("storeId");
      currentRequest.onsuccess = () => {
        const current = currentRequest.result ?? null;
        const countRequest = queue.count();
        countRequest.onsuccess = () => {
          const count = countRequest.result;
          if (current === id) { result = { bound: true }; return; }
          if (current !== expectedCurrent) { result = { bound: false, current, count }; return; }
          if ((!current && count && !acceptLegacy) || (current && current !== id && (count || !allowSwitch))) {
            result = { bound: false, current, count };
            return;
          }
          if (current !== id) {
            snapshots.delete("products");
            snapshots.delete("customers");
          }
          snapshots.put(id, "storeId");
          result = { bound: true };
        };
      };
    });
  }

  async function transaction(storeName, mode, run) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      let result;
      let failure;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("Offline transaction was aborted"));
      const setResult = (value) => { result = value; };
      const abort = (error) => {
        failure = error;
        tx.abort();
      };
      try {
        run(tx.objectStore(storeName), setResult, abort);
      } catch (error) {
        abort(error);
      }
    });
  }

  function validatedKey(key) {
    if (!SNAPSHOT_KEYS.has(key)) throw new TypeError("Unknown POS snapshot key");
    return key;
  }

  function saleId(id) {
    if (typeof id !== "string" || !UUID.test(id)) throw new TypeError("Invalid sale ID");
    return id.toLowerCase();
  }

  function canonicalJson(value) {
    if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
    if (value !== null && typeof value === "object") {
      return "{" + Object.keys(value).sort().map((key) =>
        JSON.stringify(key) + ":" + canonicalJson(value[key])
      ).join(",") + "}";
    }
    return JSON.stringify(value);
  }

  function queueEntry(row) {
    const { payload, state, error } = row;
    return { payload, state, error };
  }

  async function getSnapshot(key, expected) {
    validatedKey(key);
    return guarded(expected, (queue, snapshots, setResult) => {
      const request = snapshots.get(key);
      request.onsuccess = () => setResult(request.result ?? null);
    });
  }

  async function putSnapshot(key, value, expected) {
    validatedKey(key);
    await guarded(expected, (queue, snapshots) => { snapshots.put(value, key); });
  }

  async function list() {
    return transaction(QUEUE, "readonly", (store, setResult) => {
      const request = store.getAll();
      request.onsuccess = () => setResult(request.result.map(queueEntry));
    });
  }

  async function listForStore(expected) {
    return guarded(expected, (queue, snapshots, setResult) => {
      const request = queue.getAll();
      request.onsuccess = () => setResult(request.result.map(queueEntry));
    });
  }

  async function exportQueue() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([SNAPSHOTS, QUEUE], "readonly");
      let id = null, entries = [];
      tx.oncomplete = () => resolve({ storeId: id, entries });
      tx.onabort = () => reject(tx.error ?? new Error("Cannot read queue"));
      const binding = tx.objectStore(SNAPSHOTS).get("storeId");
      const rows = tx.objectStore(QUEUE).getAll();
      binding.onsuccess = () => { id = binding.result ?? null; };
      rows.onsuccess = () => { entries = rows.result.map(queueEntry); };
    });
  }

  async function put(payload, expected) {
    const id = saleId(payload?.id);
    const submitted = structuredClone({ ...payload, id });
    const signature = canonicalJson(submitted);
    return guarded(expected, (store, snapshots, setResult, abort) => {
      const request = store.index("saleId").get(id);
      request.onsuccess = () => {
        const existing = request.result;
        if (existing) {
          if (existing.signature !== signature) {
            abort(new Error("This offline sale ID already has different data"));
            return;
          }
          setResult(queueEntry(existing));
          return;
        }
        const row = { id, signature, payload: submitted, state: "pending", error: null };
        store.add(row);
        setResult(queueEntry(row));
      };
    });
  }

  function hasFields(value, required, optional = []) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && required.every((key) => Object.hasOwn(value, key))
      && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
  }

  function amount(value, places, limit, positive = false) {
    if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
    if (typeof value !== "string" || value.length > 40) throw new TypeError("Invalid sale amount");
    const match = /^(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value);
    if (!match || !(match[1] || match[2])) throw new TypeError("Invalid sale amount");
    const fraction = match[2] ?? "";
    const power = Number(match[3] ?? 0) + places - fraction.length;
    if (!Number.isInteger(power) || Math.abs(power) > 40) throw new TypeError("Invalid sale amount");
    const digits = BigInt(match[1] + fraction);
    const scale = 10n ** BigInt(Math.abs(power));
    if (power < 0 && digits % scale !== 0n) throw new TypeError("Invalid sale amount precision");
    const scaled = power < 0 ? digits / scale : digits * scale;
    if (scaled > limit * 10n ** BigInt(places) || (positive && scaled === 0n)) {
      throw new TypeError("Sale amount is outside the supported range");
    }
    return scaled;
  }

  function validSaleTime(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || value.startsWith("0000-")) return false;
    const time = new Date(value);
    return Number.isFinite(time.getTime()) && time.toISOString() === value;
  }

  function validatedImportEntry(entry) {
    if (!hasFields(entry, ["payload", "state", "error"]) || !STATES.has(entry.state)
      || (entry.error !== null && (typeof entry.error !== "string" || entry.error.length > 1000))) {
      throw new TypeError("Invalid offline queue entry");
    }
    const { payload, state, error } = entry;
    if (!hasFields(payload, ["id", "items", "payments", "customer_id", "qr_confirmed"], ["offline", "sold_at"])
      || !Array.isArray(payload.items) || !payload.items.length
      || !hasFields(payload.payments, ["cash", "qr", "credit"])
      || typeof payload.qr_confirmed !== "boolean"
      || (Object.hasOwn(payload, "offline") && typeof payload.offline !== "boolean")
      || (Object.hasOwn(payload, "sold_at") && (payload.offline !== true || !validSaleTime(payload.sold_at)))) {
      throw new TypeError("Invalid offline sale");
    }
    const id = saleId(payload.id);
    if (payload.customer_id !== null) saleId(payload.customer_id);
    for (const item of payload.items) {
      if (!hasFields(item, ["product_id", "unit_id", "quantity", "expected_unit_price"])) {
        throw new TypeError("Invalid offline sale item");
      }
      saleId(item.product_id);
      saleId(item.unit_id);
      amount(item.quantity, 6, 10n ** 9n, true);
      amount(item.expected_unit_price, 6, 10n ** 9n);
    }
    const { cash, qr, credit } = payload.payments;
    const paymentLimit = 10n ** 22n;
    amount(cash, 2, paymentLimit);
    const qrAmount = amount(qr, 2, paymentLimit);
    const creditAmount = amount(credit, 2, paymentLimit);
    if ((qrAmount && !payload.qr_confirmed) || (creditAmount && payload.customer_id === null)) {
      throw new TypeError("Incomplete offline sale payment");
    }
    const submitted = structuredClone({ ...payload, id });
    return { id, signature: canonicalJson(submitted), payload: submitted, state, error };
  }

  async function importQueue(entries, expected) {
    if (!Array.isArray(entries)) {
      throw new TypeError("A queue backup must contain an array of entries");
    }
    const rows = Array.from(entries, validatedImportEntry);
    return guarded(expected, (store, snapshots, setResult, abort) => {
      const index = store.index("saleId");
      const totals = { imported: 0, duplicates: 0 };
      let position = 0;

      function next() {
        if (position === rows.length) {
          setResult(totals);
          return;
        }
        const row = rows[position++];
        const request = index.get(row.id);
        request.onsuccess = () => {
          const existing = request.result;
          if (existing && existing.signature !== row.signature) {
            abort(new Error("This offline sale ID already has different data"));
            return;
          }
          if (existing) {
            totals.duplicates++;
          } else {
            store.add(row);
            totals.imported++;
          }
          next();
        };
      }
      next();
    });
  }

  async function update(id, state, error = null, expected) {
    id = saleId(id);
    if (!STATES.has(state)) throw new TypeError("Unknown offline sale state");
    if (error !== null && typeof error !== "string") throw new TypeError("Invalid offline error");
    return guarded(expected, (store, snapshots, setResult) => {
      const request = store.index("saleId").get(id);
      request.onsuccess = () => {
        const existing = request.result;
        if (!existing) {
          setResult(null);
          return;
        }
        const row = { ...existing, state, error };
        store.put(row);
        setResult(queueEntry(row));
      };
    });
  }

  async function remove(id, expected) {
    id = saleId(id);
    await guarded(expected, (store) => {
      const request = store.index("saleId").getKey(id);
      request.onsuccess = () => {
        if (request.result !== undefined) store.delete(request.result);
      };
    });
  }

  window.PosOffline = { getSnapshot, putSnapshot, list, listForStore, exportQueue, put, update, remove, importQueue, getBinding, bindStore };
})();
