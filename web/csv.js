(() => {
  function cell(value, userText = false) {
    let text = String(value ?? "");
    // Keep user-entered names and units from being interpreted as formulas.
    if (userText && /^[\s\u0000-\u001f]*[=+\-@＝＋－＠]|^[\t\r\n]/u.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  }

  function download(filename, rows) {
    const contents = "\uFEFF" + rows.map((row) => row.join(",")).join("\r\n") + "\r\n";
    const url = URL.createObjectURL(new Blob([contents], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.PosCsv = { cell, download };
})();
