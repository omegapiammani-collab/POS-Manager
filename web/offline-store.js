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
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore(SNAPSHOTS);
          const queue = db.createObjectStore(QUEUE, { keyPath: "sequence", autoIncrement: true });
          queue.createIndex("saleId", "id", { unique: true });
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

  async function getSnapshot(key) {
    validatedKey(key);
    return transaction(SNAPSHOTS, "readonly", (store, setResult) => {
      const request = store.get(key);
      request.onsuccess = () => setResult(request.result ?? null);
    });
  }

  async function putSnapshot(key, value) {
    validatedKey(key);
    await transaction(SNAPSHOTS, "readwrite", (store) => { store.put(value, key); });
  }

  async function list() {
    return transaction(QUEUE, "readonly", (store, setResult) => {
      const request = store.getAll();
      request.onsuccess = () => setResult(request.result.map(queueEntry));
    });
  }

  async function put(payload) {
    const id = saleId(payload?.id);
    const submitted = structuredClone({ ...payload, id });
    const signature = canonicalJson(submitted);
    return transaction(QUEUE, "readwrite", (store, setResult, abort) => {
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

  async function update(id, state, error = null) {
    id = saleId(id);
    if (!STATES.has(state)) throw new TypeError("Unknown offline sale state");
    if (error !== null && typeof error !== "string") throw new TypeError("Invalid offline error");
    return transaction(QUEUE, "readwrite", (store, setResult) => {
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

  async function remove(id) {
    id = saleId(id);
    await transaction(QUEUE, "readwrite", (store) => {
      const request = store.index("saleId").getKey(id);
      request.onsuccess = () => {
        if (request.result !== undefined) store.delete(request.result);
      };
    });
  }

  window.PosOffline = { getSnapshot, putSnapshot, list, put, update, remove };
})();
