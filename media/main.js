(function () {
  const vscode = acquireVsCodeApi();
  const log = document.getElementById("log");
  const form = document.getElementById("composer");
  const input = document.getElementById("input");
  const usageBar = document.getElementById("usage-bar");
  const usageFill = document.getElementById("usage-fill");
  const usageLabel = document.getElementById("usage-label");

  function appendLine(text, className) {
    const line = document.createElement("div");
    line.className = className;
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
    return line;
  }

  function agentClass(message) {
    return message.agent ? ` agent-${message.agent}` : "";
  }

  function renderQuestion(message) {
    const container = document.createElement("div");
    container.className = "question" + agentClass(message);

    const selections = {};
    for (const q of message.questions) {
      selections[q.id] = new Set();

      const block = document.createElement("div");
      block.className = "question-block";

      const header = document.createElement("div");
      header.className = "question-header";
      header.textContent = q.header;
      block.appendChild(header);

      const questionText = document.createElement("div");
      questionText.className = "question-text";
      questionText.textContent = q.question;
      block.appendChild(questionText);

      const optionsWrap = document.createElement("div");
      optionsWrap.className = "question-options";
      for (const opt of q.options) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "question-option";
        btn.textContent = opt.description ? `${opt.label} — ${opt.description}` : opt.label;
        btn.addEventListener("click", () => {
          if (q.multiSelect) {
            if (selections[q.id].has(opt.label)) {
              selections[q.id].delete(opt.label);
              btn.classList.remove("selected");
            } else {
              selections[q.id].add(opt.label);
              btn.classList.add("selected");
            }
          } else {
            selections[q.id] = new Set([opt.label]);
            for (const sibling of optionsWrap.children) {
              sibling.classList.remove("selected");
            }
            btn.classList.add("selected");
          }
        });
        optionsWrap.appendChild(btn);
      }
      block.appendChild(optionsWrap);
      container.appendChild(block);
    }

    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "question-submit";
    submit.textContent = "Submit";
    submit.addEventListener("click", () => {
      const answers = {};
      for (const q of message.questions) {
        answers[q.id] = Array.from(selections[q.id]);
      }
      vscode.postMessage({ type: "answerQuestion", id: message.id, answers });
      container.remove();
      appendLine("(answered)", "meta" + agentClass(message));
    });
    container.appendChild(submit);

    log.appendChild(container);
    log.scrollTop = log.scrollHeight;
  }

  function renderPermission(message) {
    const container = document.createElement("div");
    container.className = "permission" + agentClass(message);

    const title = document.createElement("div");
    title.className = "permission-title";
    title.textContent = message.title;
    container.appendChild(title);

    if (message.description) {
      const desc = document.createElement("div");
      desc.className = "permission-description";
      desc.textContent = message.description;
      container.appendChild(desc);
    }

    const buttons = document.createElement("div");
    buttons.className = "permission-buttons";
    const choices = [
      ["allow-once", "Allow once"],
      ["allow-session", "Allow for session"],
      ["deny", "Deny"],
    ];
    for (const [decision, label] of choices) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "permission-button" + (decision === "deny" ? " deny" : "");
      btn.textContent = label;
      btn.addEventListener("click", () => {
        vscode.postMessage({ type: "resolvePermission", id: message.id, decision });
        container.remove();
        appendLine(`(${label.toLowerCase()})`, "meta" + agentClass(message));
      });
      buttons.appendChild(btn);
    }
    container.appendChild(buttons);

    log.appendChild(container);
    log.scrollTop = log.scrollHeight;
  }

  function renderUsage(message) {
    if (message.rateLimitFiveHour) {
      const pct = Math.round(message.rateLimitFiveHour.utilization);
      usageFill.style.width = `${Math.min(100, pct)}%`;
      usageFill.classList.toggle("usage-fill-warning", pct >= 80);
      const resetsAt = message.rateLimitFiveHour.resetsAt;
      const resetText = resetsAt ? ` (resets ${new Date(resetsAt).toLocaleTimeString()})` : "";
      usageLabel.textContent = `5h limit: ${pct}%${resetText}`;
      usageBar.hidden = false;
    } else if (typeof message.contextPercentage === "number") {
      const pct = Math.round(message.contextPercentage);
      usageFill.style.width = `${Math.min(100, pct)}%`;
      usageFill.classList.toggle("usage-fill-warning", pct >= 80);
      usageLabel.textContent = `Context: ${pct}%`;
      usageBar.hidden = false;
    } else if (typeof message.costUsd === "number") {
      usageLabel.textContent = `Session cost: $${message.costUsd.toFixed(4)}`;
      usageBar.hidden = false;
    }
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
      case "text":
        appendLine(message.text, "chunk" + agentClass(message));
        break;
      case "toolUse":
        appendLine(`⚙ ${message.label}`, "tool-use" + agentClass(message));
        break;
      case "question":
        renderQuestion(message);
        break;
      case "permission":
        renderPermission(message);
        break;
      case "usage":
        renderUsage(message);
        break;
      case "done":
        appendLine(`(exited ${message.exitCode})`, "meta" + agentClass(message));
        break;
      case "error":
        appendLine(`Error: ${message.message}`, "error");
        break;
      case "scan":
        appendLine(message.text, "scan");
        break;
    }
  });
})();
