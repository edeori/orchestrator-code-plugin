(function () {
  const vscode = acquireVsCodeApi();
  const log = document.getElementById("log");
  const form = document.getElementById("composer");
  const input = document.getElementById("input");
  const sendButton = document.getElementById("send");
  const sendLabel = sendButton.querySelector(".send-label");
  const stopButton = document.getElementById("stop");
  const queueButton = document.getElementById("queue");
  const scanButton = document.getElementById("scan-project");
  const sessionPicker = document.getElementById("session-picker");
  const newSessionButton = document.getElementById("new-session");
  const sessionDetail = document.getElementById("session-detail");
  const usagePanel = document.getElementById("usage-panel");
  const interactions = new Map();
  const activities = new Map();
  const usageByAgent = new Map();
  let activeTextLine = null;
  let activeTextAgent = null;
  let stateTimer = null;
  let running = false;
  let sessionBusy = false;
  let queuedMessageCount = 0;

  const restoredState = vscode.getState() || {};
  const sessionViews =
    restoredState.sessionViews && typeof restoredState.sessionViews === "object"
      ? restoredState.sessionViews
      : {};
  let currentSessionId =
    typeof restoredState.activeSessionId === "string"
      ? restoredState.activeSessionId
      : null;
  const restoredView = currentSessionId ? sessionViews[currentSessionId] : null;
  log.innerHTML =
    typeof restoredView?.transcriptHtml === "string"
      ? restoredView.transcriptHtml
      : typeof restoredState.transcriptHtml === "string"
        ? restoredState.transcriptHtml
        : "";
  input.value =
    typeof restoredView?.draft === "string"
      ? restoredView.draft
      : typeof restoredState.draft === "string"
        ? restoredState.draft
        : "";

  function captureTranscriptHtml() {
    const transcript = log.cloneNode(true);
    for (const pending of transcript.querySelectorAll(".question, .permission, .elicitation")) {
      pending.remove();
    }
    while (transcript.innerHTML.length > 100_000 && transcript.firstElementChild) {
      transcript.firstElementChild.remove();
    }
    return transcript.innerHTML;
  }

  function persistWebviewState() {
    if (stateTimer !== null) {
      clearTimeout(stateTimer);
      stateTimer = null;
    }
    if (currentSessionId) {
      sessionViews[currentSessionId] = {
        transcriptHtml: captureTranscriptHtml(),
        draft: input.value,
      };
    }
    vscode.setState({
      activeSessionId: currentSessionId,
      sessionViews,
    });
  }

  function scheduleStatePersistence() {
    if (stateTimer !== null) clearTimeout(stateTimer);
    stateTimer = setTimeout(persistWebviewState, 150);
  }

  new MutationObserver(scheduleStatePersistence).observe(log, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  input.addEventListener("input", scheduleStatePersistence);
  window.addEventListener("beforeunload", persistWebviewState);
  requestAnimationFrame(scrollToBottom);

  function restoreSessionView(id) {
    for (const container of interactions.values()) {
      if (container.dataset.timer) clearInterval(Number(container.dataset.timer));
    }
    interactions.clear();
    activities.clear();
    usageByAgent.clear();
    usagePanel.replaceChildren();
    usagePanel.hidden = true;
    activeTextLine = null;
    activeTextAgent = null;
    const view = sessionViews[id];
    log.innerHTML = typeof view?.transcriptHtml === "string" ? view.transcriptHtml : "";
    input.value = typeof view?.draft === "string" ? view.draft : "";
    requestAnimationFrame(scrollToBottom);
  }

  function switchSessionView(id) {
    if (currentSessionId === id) return;
    persistWebviewState();
    currentSessionId = id;
    restoreSessionView(id);
    persistWebviewState();
  }

  function shortId(id) {
    return typeof id === "string" && id.length > 12 ? `${id.slice(0, 8)}…` : id || "not created";
  }

  function renderSessionList(message) {
    const firstSession = !currentSessionId;
    if (firstSession) {
      currentSessionId = message.activeSessionId;
      if (!sessionViews[currentSessionId] && log.childElementCount > 0) {
        sessionViews[currentSessionId] = {
          transcriptHtml: captureTranscriptHtml(),
          draft: input.value,
        };
      } else {
        restoreSessionView(currentSessionId);
      }
    } else {
      switchSessionView(message.activeSessionId);
    }

    sessionPicker.replaceChildren();
    for (const session of message.sessions) {
      const option = document.createElement("option");
      option.value = session.id;
      const updated = new Date(session.updatedAt).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      option.textContent = `${session.title} · ${updated}`;
      sessionPicker.appendChild(option);
    }
    sessionPicker.value = message.activeSessionId;
    const active = message.sessions.find((session) => session.id === message.activeSessionId);
    sessionDetail.replaceChildren();
    if (active) {
      sessionDetail.append(
        createSessionProvider("Claude", active.claudeSessionId),
        createSessionProvider("Codex", active.codexThreadId)
      );
    }
    sessionBusy = false;
    updateControls();
    persistWebviewState();
  }

  function createSessionProvider(label, id) {
    const provider = document.createElement("span");
    provider.className = "session-provider";
    provider.title = id || `${label} session has not been created yet`;

    const indicator = document.createElement("span");
    indicator.className = `session-provider-indicator${id ? " connected" : ""}`;
    indicator.setAttribute("aria-hidden", "true");

    const name = document.createElement("span");
    name.className = "session-provider-name";
    name.textContent = label;

    const identifier = document.createElement("span");
    identifier.className = "session-provider-id";
    identifier.textContent = shortId(id);

    provider.append(indicator, name, identifier);
    return provider;
  }

  function appendLine(text, className) {
    activeTextLine = null;
    activeTextAgent = null;
    const line = document.createElement("div");
    line.className = className;
    line.textContent = text;
    log.appendChild(line);
    scrollToBottom();
    return line;
  }

  function appendTextChunk(message) {
    const agent = message.agent || "unknown";
    if (!activeTextLine || !activeTextLine.isConnected || activeTextAgent !== agent) {
      activeTextLine = document.createElement("div");
      activeTextLine.className = "chunk" + agentClass(message);
      activeTextLine.textContent = "";
      activeTextAgent = agent;
      log.appendChild(activeTextLine);
    }
    activeTextLine.textContent += message.text;
    scrollToBottom();
  }

  function scrollToBottom() {
    log.scrollTop = log.scrollHeight;
  }

  function agentClass(message) {
    return message.agent ? ` agent-${message.agent}` : "";
  }

  function renderQuestion(message) {
    const container = document.createElement("div");
    container.className = "question" + agentClass(message);
    const selections = {};
    const freeInputs = {};

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
      for (const opt of q.options || []) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "question-option";
        btn.textContent = opt.description ? `${opt.label} — ${opt.description}` : opt.label;
        btn.addEventListener("click", () => {
          if (freeInputs[q.id]) freeInputs[q.id].value = "";
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
            for (const sibling of optionsWrap.querySelectorAll(".question-option")) {
              sibling.classList.remove("selected");
            }
            btn.classList.add("selected");
          }
        });
        optionsWrap.appendChild(btn);
      }
      block.appendChild(optionsWrap);

      if (q.allowFreeText || q.isOther) {
        const freeInput = document.createElement("input");
        freeInput.className = "question-free-text";
        freeInput.type = q.isSecret ? "password" : "text";
        freeInput.placeholder = q.isOther ? "Other…" : "Type your answer…";
        freeInput.autocomplete = "off";
        freeInput.addEventListener("input", () => {
          if (!q.multiSelect && freeInput.value) {
            selections[q.id].clear();
            for (const sibling of optionsWrap.querySelectorAll(".question-option")) {
              sibling.classList.remove("selected");
            }
          }
        });
        freeInputs[q.id] = freeInput;
        block.appendChild(freeInput);
      }
      container.appendChild(block);
    }

    const validation = document.createElement("div");
    validation.className = "question-validation";
    container.appendChild(validation);

    if (typeof message.autoResolutionMs === "number") {
      const deadline = Date.now() + message.autoResolutionMs;
      const countdown = document.createElement("div");
      countdown.className = "question-countdown";
      const updateCountdown = () => {
        const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        countdown.textContent = `Continues automatically in ${seconds}s`;
      };
      updateCountdown();
      const timer = setInterval(updateCountdown, 1000);
      container.dataset.timer = String(timer);
      container.appendChild(countdown);
    }

    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "question-submit";
    submit.textContent = "Submit";
    submit.addEventListener("click", () => {
      const answers = {};
      for (const q of message.questions) {
        const values = Array.from(selections[q.id]);
        const freeValue = freeInputs[q.id]?.value.trim();
        if (freeValue) values.push(freeValue);
        if (values.length === 0) {
          validation.textContent = "Please answer every question.";
          return;
        }
        answers[q.id] = values;
      }
      vscode.postMessage({ type: "answerQuestion", id: message.id, answers });
      removeInteraction(message.id);
      appendLine("(answered)", "meta" + agentClass(message));
    });
    container.appendChild(submit);

    interactions.set(message.id, container);
    log.appendChild(container);
    scrollToBottom();
  }

  function renderPermission(message) {
    const container = document.createElement("div");
    container.className = `permission permission-${message.kind || "tool"}` + agentClass(message);

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

    const labels = {
      "allow-once": "Allow once",
      "allow-session": "Allow for session",
      "allow-repo": "Always allow (this repo)",
      deny: "Deny",
    };
    const buttons = document.createElement("div");
    buttons.className = "permission-buttons";
    for (const decision of message.availableDecisions || ["allow-once", "allow-session", "deny"]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "permission-button" + (decision === "deny" ? " deny" : decision === "allow-repo" ? " repo" : "");
      btn.textContent = labels[decision] || decision;
      btn.addEventListener("click", () => {
        vscode.postMessage({ type: "resolvePermission", id: message.id, decision });
        removeInteraction(message.id);
        appendLine(`(${btn.textContent.toLowerCase()})`, "meta" + agentClass(message));
      });
      buttons.appendChild(btn);
    }
    container.appendChild(buttons);

    interactions.set(message.id, container);
    log.appendChild(container);
    scrollToBottom();
  }

  function renderElicitation(message) {
    const container = document.createElement("div");
    container.className = "elicitation" + agentClass(message);

    const title = document.createElement("div");
    title.className = "elicitation-title";
    title.textContent = message.title || `${message.serverName} needs input`;
    container.appendChild(title);

    const description = document.createElement("div");
    description.className = "elicitation-description";
    description.textContent = message.message;
    container.appendChild(description);

    if (message.mode === "url") {
      if (message.url) {
        const url = document.createElement("div");
        url.className = "elicitation-url";
        url.textContent = message.url;
        container.appendChild(url);

        const open = document.createElement("button");
        open.type = "button";
        open.className = "elicitation-open";
        open.textContent = "Open in browser";
        open.addEventListener("click", () => vscode.postMessage({ type: "openExternal", url: message.url }));
        container.appendChild(open);
      }
      container.appendChild(
        elicitationActions(message, () => ({ action: "accept" }), "Done")
      );
    } else {
      const formFields = buildElicitationForm(container, message.schema || {});
      const validation = document.createElement("div");
      validation.className = "question-validation";
      container.appendChild(validation);
      container.appendChild(
        elicitationActions(
          message,
          () => {
            const content = {};
            for (const field of formFields) {
              const result = field.read();
              if (!result.valid) {
                validation.textContent = result.error || `Invalid value: ${field.name}`;
                return null;
              }
              if (result.present) content[field.name] = result.value;
            }
            validation.textContent = "";
            return { action: "accept", content };
          },
          "Submit"
        )
      );
    }

    interactions.set(message.id, container);
    log.appendChild(container);
    scrollToBottom();
  }

  function buildElicitationForm(container, schema) {
    const properties = schema && typeof schema.properties === "object" ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const fields = [];

    for (const [name, rawDefinition] of Object.entries(properties || {})) {
      const definition = rawDefinition && typeof rawDefinition === "object" ? rawDefinition : {};
      const field = document.createElement("label");
      field.className = "elicitation-field";
      const label = document.createElement("span");
      label.className = "elicitation-field-label";
      label.textContent = `${definition.title || name}${required.has(name) ? " *" : ""}`;
      field.appendChild(label);
      if (definition.description) {
        const help = document.createElement("span");
        help.className = "elicitation-field-help";
        help.textContent = definition.description;
        field.appendChild(help);
      }

      const descriptor = createElicitationControl(name, definition, required.has(name));
      field.appendChild(descriptor.element);
      container.appendChild(field);
      fields.push(descriptor);
    }

    if (fields.length === 0) {
      const empty = document.createElement("div");
      empty.className = "elicitation-field-help";
      empty.textContent = "No form fields were requested; you can accept, decline or cancel.";
      container.appendChild(empty);
    }
    return fields;
  }

  function createElicitationControl(name, definition, required) {
    const enumOptions = extractEnumOptions(definition);
    if (definition.type === "array") {
      const wrap = document.createElement("div");
      wrap.className = "elicitation-checkboxes";
      const defaults = new Set(Array.isArray(definition.default) ? definition.default.map(String) : []);
      const inputs = enumOptions.map((option) => {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = option.value;
        input.checked = defaults.has(option.value);
        label.append(input, document.createTextNode(option.title));
        wrap.appendChild(label);
        return input;
      });
      return {
        name,
        element: wrap,
        read: () => {
          const value = inputs.filter((item) => item.checked).map((item) => item.value);
          const minimum = typeof definition.minItems === "number" ? definition.minItems : required ? 1 : 0;
          const maximum = typeof definition.maxItems === "number" ? definition.maxItems : Infinity;
          if (value.length < minimum) return { valid: false, error: `${name} needs at least ${minimum} selection(s).` };
          if (value.length > maximum) return { valid: false, error: `${name} allows at most ${maximum} selection(s).` };
          return { valid: true, present: value.length > 0, value };
        },
      };
    }

    if (enumOptions.length) {
      const select = document.createElement("select");
      select.className = "elicitation-input";
      if (!required) select.appendChild(new Option("", ""));
      for (const option of enumOptions) select.appendChild(new Option(option.title, option.value));
      if (typeof definition.default === "string") select.value = definition.default;
      return {
        name,
        element: select,
        read: () =>
          required && !select.value
            ? { valid: false, error: `${name} is required.` }
            : { valid: true, present: Boolean(select.value), value: select.value },
      };
    }

    if (definition.type === "boolean") {
      if (!required) {
        const select = document.createElement("select");
        select.className = "elicitation-input";
        select.append(new Option("Not specified", ""), new Option("Yes", "true"), new Option("No", "false"));
        if (typeof definition.default === "boolean") select.value = String(definition.default);
        return {
          name,
          element: select,
          read: () => ({
            valid: true,
            present: select.value !== "",
            value: select.value === "true",
          }),
        };
      }
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = definition.default === true;
      return {
        name,
        element: checkbox,
        read: () => ({ valid: true, present: true, value: checkbox.checked }),
      };
    }

    const input = document.createElement("input");
    input.className = "elicitation-input";
    const numeric = definition.type === "number" || definition.type === "integer";
    input.type = numeric
      ? "number"
      : definition.format === "email"
        ? "email"
        : definition.format === "date"
          ? "date"
          : definition.format === "date-time"
            ? "datetime-local"
            : definition.format === "uri"
              ? "url"
              : definition.format === "password" || definition.writeOnly === true
                ? "password"
                : "text";
    if (definition.default !== undefined) input.value = String(definition.default);
    if (typeof definition.minLength === "number") input.minLength = definition.minLength;
    if (typeof definition.maxLength === "number") input.maxLength = definition.maxLength;
    if (typeof definition.minimum === "number") input.min = String(definition.minimum);
    if (typeof definition.maximum === "number") input.max = String(definition.maximum);
    input.required = required;

    return {
      name,
      element: input,
      read: () => {
        if (!input.checkValidity()) return { valid: false, error: input.validationMessage || `${name} is invalid.` };
        if (!input.value && !required) return { valid: true, present: false };
        const value = numeric ? Number(input.value) : input.value;
        if (numeric && !Number.isFinite(value)) return { valid: false, error: `${name} must be a number.` };
        return { valid: true, present: true, value };
      },
    };
  }

  function extractEnumOptions(definition) {
    if (Array.isArray(definition.enum)) {
      return definition.enum.map((value, index) => ({
        value: String(value),
        title: String(definition.enumNames?.[index] ?? value),
      }));
    }
    const variants = Array.isArray(definition.oneOf)
      ? definition.oneOf
      : Array.isArray(definition.items?.anyOf)
        ? definition.items.anyOf
        : Array.isArray(definition.items?.oneOf)
          ? definition.items.oneOf
        : null;
    if (variants) {
      return variants
        .filter((variant) => variant && typeof variant === "object" && variant.const !== undefined)
        .map((variant) => ({ value: String(variant.const), title: String(variant.title ?? variant.const) }));
    }
    if (Array.isArray(definition.items?.enum)) {
      return definition.items.enum.map((value) => ({ value: String(value), title: String(value) }));
    }
    return [];
  }

  function elicitationActions(message, acceptedResponse, acceptLabel) {
    const actions = document.createElement("div");
    actions.className = "permission-buttons";
    for (const [action, label] of [
      ["accept", acceptLabel],
      ["decline", "Decline"],
      ["cancel", "Cancel"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "permission-button" + (action !== "accept" ? " deny" : "");
      button.textContent = label;
      button.addEventListener("click", () => {
        const response = action === "accept" ? acceptedResponse() : { action };
        if (!response) return;
        vscode.postMessage({ type: "resolveElicitation", id: message.id, ...response });
        removeInteraction(message.id);
        appendLine(`(${action})`, "meta" + agentClass(message));
      });
      actions.appendChild(button);
    }
    return actions;
  }

  function removeInteraction(id) {
    const container = interactions.get(id);
    if (!container) return false;
    if (container.dataset.timer) clearInterval(Number(container.dataset.timer));
    container.remove();
    interactions.delete(id);
    return true;
  }

  function renderActivity(message) {
    const key = `${message.agent || "unknown"}:${message.id}`;
    let line = activities.get(key);
    if (!line) {
      line = appendLine("", "tool-use" + agentClass(message));
      activities.set(key, line);
    }
    const icon = message.status === "completed" ? "✓" : message.status === "failed" ? "✗" : "⚙";
    line.textContent = `${icon} ${message.label}${message.detail ? `\n  ${message.detail}` : ""}`;
    line.classList.toggle("activity-failed", message.status === "failed");
    if (message.status !== "started") activities.delete(key);
  }

  function renderUsage(message) {
    const agent = message.agent || "unknown";
    const state = usageByAgent.get(agent) || { rateLimits: new Map() };
    if (message.context) state.context = message.context;
    if (typeof message.costUsd === "number") state.costUsd = message.costUsd;
    for (const rateLimit of message.rateLimits || []) state.rateLimits.set(rateLimit.id, rateLimit);
    usageByAgent.set(agent, state);

    usagePanel.replaceChildren();
    for (const [agentName, agentUsage] of usageByAgent) {
      const section = document.createElement("section");
      section.className = `usage-agent agent-${agentName}`;
      const title = document.createElement("div");
      title.className = "usage-agent-title";
      title.textContent = agentName;
      section.appendChild(title);

      if (agentUsage.context) {
        section.appendChild(
          createMeter(
            "Context",
            agentUsage.context.percentage,
            `${formatTokens(agentUsage.context.usedTokens)} / ${formatTokens(agentUsage.context.maxTokens)}`
          )
        );
      }
      for (const limit of agentUsage.rateLimits.values()) {
        const reset = limit.resetsAt ? ` · resets ${new Date(limit.resetsAt * 1000).toLocaleTimeString()}` : "";
        section.appendChild(createMeter(limit.label, limit.usedPercent, `${Math.round(limit.usedPercent)}%${reset}`));
      }
      if (typeof agentUsage.costUsd === "number") {
        const cost = document.createElement("div");
        cost.className = "usage-cost";
        cost.textContent = `Session cost: $${agentUsage.costUsd.toFixed(4)}`;
        section.appendChild(cost);
      }
      usagePanel.appendChild(section);
    }
    usagePanel.hidden = usageByAgent.size === 0;
  }

  function createMeter(label, percentage, detail) {
    const row = document.createElement("div");
    row.className = "usage-row";
    const fill = document.createElement("div");
    fill.className = "usage-fill" + (percentage >= 80 ? " usage-fill-warning" : "");
    fill.style.width = `${Math.max(0, Math.min(100, percentage))}%`;
    const text = document.createElement("span");
    text.className = "usage-label";
    text.textContent = `${label}: ${detail}`;
    row.append(fill, text);
    return row;
  }

  function formatTokens(tokens) {
    return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(tokens);
  }

  function setRunning(value) {
    running = value;
    updateControls();
  }

  function updateControls() {
    const blocked = running || sessionBusy;
    input.disabled = sessionBusy;
    sendButton.disabled = sessionBusy;
    scanButton.disabled = blocked;
    sessionPicker.disabled = blocked;
    newSessionButton.disabled = blocked;
    stopButton.hidden = !running;
    stopButton.disabled = false;
    queueButton.hidden = !running;
    queueButton.disabled = sessionBusy;
    queueButton.textContent = queuedMessageCount ? `Queue (${queuedMessageCount})` : "Queue";
    // While a turn is running, "Send now" still submits (it steers the
    // active turn instead of starting a new one) — the spinner just makes
    // it visible that Codex/Claude is already busy with the previous
    // request rather than idle, so it doesn't read as an unresponsive click.
    sendButton.classList.toggle("is-running", running);
    sendLabel.textContent = running ? "Send now" : "Send";
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || sendButton.disabled) return;
    appendLine((running ? "» " : "> ") + text, running ? "user user-steer" : "user");
    vscode.postMessage({ type: running ? "steerMessage" : "userMessage", text });
    input.value = "";
    if (!running) setRunning(true);
    scheduleStatePersistence();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    form.requestSubmit();
  });

  stopButton.addEventListener("click", () => {
    stopButton.disabled = true;
    vscode.postMessage({ type: "stop" });
  });

  scanButton.addEventListener("click", () => {
    vscode.postMessage({ type: "scanProject" });
  });

  queueButton.addEventListener("click", () => {
    const text = input.value.trim();
    if (!text || queueButton.disabled) return;
    appendLine(`⌛ ${text}`, "user user-queued");
    vscode.postMessage({ type: "queueMessage", text });
    input.value = "";
    scheduleStatePersistence();
  });

  sessionPicker.addEventListener("change", () => {
    if (!sessionPicker.value || sessionPicker.value === currentSessionId) return;
    sessionBusy = true;
    updateControls();
    persistWebviewState();
    vscode.postMessage({ type: "switchSession", id: sessionPicker.value });
  });

  newSessionButton.addEventListener("click", () => {
    sessionBusy = true;
    updateControls();
    persistWebviewState();
    vscode.postMessage({ type: "newSession" });
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "routing":
        appendLine(
          `[routed to ${message.agent} · ${message.model}] ${message.reason}`,
          "routing"
        );
        break;
      case "text":
        appendTextChunk(message);
        break;
      case "activity":
        renderActivity(message);
        break;
      case "question":
        renderQuestion(message);
        break;
      case "permission":
        renderPermission(message);
        break;
      case "elicitation":
        renderElicitation(message);
        break;
      case "interactionResolved":
        if (removeInteraction(message.id) && (message.resolution === "timed-out" || message.resolution === "cancelled")) {
          appendLine(`(${message.resolution})`, "meta" + agentClass(message));
        }
        break;
      case "usage":
        renderUsage(message);
        break;
      case "runState":
        setRunning(message.running);
        break;
      case "done":
        appendLine(`(exited ${message.exitCode})`, "meta" + agentClass(message));
        break;
      case "error":
        appendLine(`Error: ${message.message}`, "error" + agentClass(message));
        break;
      case "scan":
        appendLine(message.text, "scan");
        break;
      case "sessionStatus":
        appendLine(message.message, `session-status session-${message.status}`);
        break;
      case "sessionList":
        renderSessionList(message);
        break;
      case "queueState":
        queuedMessageCount = message.count;
        updateControls();
        break;
      case "composerNotice":
        appendLine(message.message, `meta composer-${message.status}`);
        break;
    }
  });
})();
