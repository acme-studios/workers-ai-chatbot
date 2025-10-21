/**
 * Cloudflare Workers AI Chat — modern UI + robust guardrails handling
 * Key upgrades:
 * - If a prompt is blocked, we (1) pop it from chatHistory and (2) add it to
 *   blockedUserContents so it will NEVER be resent on later turns.
 * - Each request sends { messages, blockedUserContents }.
 * - Safer rendering (textContent), better errors, smooth scrolling.
 */

const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

let chatHistory = [
  { role: "assistant", content: "Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?" }
];

// Any user prompts that were blocked by Guardrails get remembered here so they
// are filtered out of future requests (even if the UI somehow didn’t pop them).
const blockedUserContents = [];

let isProcessing = false;
let lastSentUserText = "";

// Seed initial assistant bubble
renderMessage("assistant", chatHistory[0].content);

// Auto-resize textarea
userInput.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 200) + "px";
});

// Enter to send (Shift+Enter for newline)
userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendButton.addEventListener("click", sendMessage);

async function sendMessage() {
  const message = userInput.value.trim();
  if (!message || isProcessing) return;

  isProcessing = true;
  setInputsEnabled(false);
  typingIndicator.classList.add("visible");

  // user bubble
  renderMessage("user", message);
  userInput.value = "";
  userInput.style.height = "auto";

  lastSentUserText = message;
  chatHistory.push({ role: "user", content: message });

  // Assistant bubble we stream into
  const assistantEl = renderMessage("assistant", "");
  const p = assistantEl.querySelector("p");

  try {
    // Filter out any previously blocked user prompts before sending
    const sanitizedMessages = chatHistory.filter(
      (m) => !(m.role === "user" && blockedUserContents.includes(m.content))
    );

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: sanitizedMessages,
        blockedUserContents // server double-checks too
      })
    });

    if (!res.ok) {
      const { text, wasPromptBlocked, wasResponseBlocked } = await mapError(res);
      p.textContent = text;

      if (wasPromptBlocked) {
        // Remove the offending user turn from chatHistory so it never comes back
        popLastUserTurn();
        // Remember it so we filter it out of all future requests (belt + suspenders)
        rememberBlockedUser(lastSentUserText);
        renderMutedNotice("That message wasn’t sent due to safety policy.");
      }

      // Response-blocked doesn’t require popping a user turn
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let acc = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          const json = JSON.parse(line.slice(5));
          if (typeof json.response === "string") {
            acc += json.response;
            p.textContent = acc; // safe — no HTML injection
            scrollToBottom();
          }
        } catch (e) {
          // Ignore partial JSON from chunk boundaries
          console.debug("Stream parse skip:", e);
        }
      }
    }

    chatHistory.push({ role: "assistant", content: acc || "…" });
  } catch (err) {
    console.error(err);
    p.textContent = "⚠️ Network or server error. Please try again.";
  } finally {
    typingIndicator.classList.remove("visible");
    isProcessing = false;
    setInputsEnabled(true);
    userInput.focus();
  }
}

function renderMessage(role, content) {
  const wrap = document.createElement("div");
  wrap.className = `message ${role}-message`;
  const p = document.createElement("p");
  p.textContent = content;
  wrap.appendChild(p);
  chatMessages.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

function renderMutedNotice(text) {
  const wrap = document.createElement("div");
  wrap.className = "message assistant-message";
  wrap.style.opacity = "0.75";
  wrap.style.fontSize = "13px";
  const p = document.createElement("p");
  p.textContent = text;
  wrap.appendChild(p);
  chatMessages.appendChild(wrap);
  scrollToBottom();
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function setInputsEnabled(enabled) {
  userInput.disabled = !enabled;
  sendButton.disabled = !enabled;
}

function popLastUserTurn() {
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    if (chatHistory[i].role === "user") {
      chatHistory.splice(i, 1);
      return;
    }
  }
}

function rememberBlockedUser(text) {
  if (!text) return;
  // Keep the list modest
  if (!blockedUserContents.includes(text)) {
    blockedUserContents.push(text);
    if (blockedUserContents.length > 20) blockedUserContents.shift();
  }
}

async function mapError(res) {
  const fallback = "Sorry, there was an error processing your request.";
  try {
    const data = await res.json();
    const msg = (data && (data.error || data.message || data.msg)) || "";
    const wasPromptBlocked = /Prompt was blocked by guardrails/i.test(msg);
    const wasResponseBlocked = /Response was blocked by guardrails/i.test(msg);

    if (wasPromptBlocked) {
      return {
        text: "⚠️ Prompt was blocked by guardrails due to security policy.",
        wasPromptBlocked: true,
        wasResponseBlocked: false
      };
    }
    if (wasResponseBlocked) {
      return {
        text: "⚠️ Response was blocked by guardrails.",
        wasPromptBlocked: false,
        wasResponseBlocked: true
      };
    }
    return { text: msg || fallback, wasPromptBlocked: false, wasResponseBlocked: false };
  } catch {
    return { text: fallback, wasPromptBlocked: false, wasResponseBlocked: false };
  }
}
