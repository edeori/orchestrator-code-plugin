(function () {
  const vscode = acquireVsCodeApi();
  const log = document.getElementById("log");
  const form = document.getElementById("composer");
  const input = document.getElementById("input");

  function appendLine(text, className) {
    const line = document.createElement("div");
    line.className = className;
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    appendLine("> " + text, "user");
    vscode.postMessage({ type: "userMessage", text });
    input.value = "";
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "routing":
        appendLine(`[routed to ${message.agent}] ${message.reason}`, "routing");
        break;
      case "chunk":
        appendLine(message.text, "chunk");
        break;
      case "done":
        appendLine(`(exited ${message.exitCode})`, "meta");
        break;
      case "error":
        appendLine(`Error: ${message.message}`, "error");
        break;
    }
  });
})();
