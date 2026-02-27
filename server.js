const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const clients = new Map(); // ws -> { username }
const chatHistory = [];
const MAX_HISTORY = 200;

// Serve static HTML
const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("Error loading page");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

// WebSocket server
const wss = new WebSocketServer({ server });

function broadcast(data, exclude = null) {
  const msg = JSON.stringify(data);
  for (const [client] of clients) {
    if (client !== exclude && client.readyState === 1) {
      client.send(msg);
    }
  }
}

function timestamp() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function userList() {
  return [...clients.values()].map((c) => c.username);
}

wss.on("connection", (ws) => {
  let registered = false;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Register username
    if (msg.type === "join") {
      const username = (msg.username || "anon").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20) || "anon";

      // Check for duplicate
      const taken = [...clients.values()].some((c) => c.username.toLowerCase() === username.toLowerCase());
      if (taken) {
        ws.send(JSON.stringify({ type: "error", message: `Username "${username}" is already taken.` }));
        return;
      }

      clients.set(ws, { username });
      registered = true;

      // Send chat history
      ws.send(JSON.stringify({ type: "history", messages: chatHistory }));

      // Announce join
      const joinMsg = { type: "system", message: `${username} joined the room`, time: timestamp() };
      chatHistory.push(joinMsg);
      if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
      broadcast(joinMsg);

      // Send updated user list
      broadcast({ type: "users", list: userList() });
      return;
    }

    if (!registered) return;

    // Chat message
    if (msg.type === "chat" && msg.text && msg.text.trim()) {
      const { username } = clients.get(ws);
      const text = msg.text.trim().slice(0, 500);

      // Handle /commands
      if (text.startsWith("/")) {
        const parts = text.split(" ");
        const cmd = parts[0].toLowerCase();

        if (cmd === "/help") {
          ws.send(JSON.stringify({
            type: "system",
            message: "Commands: /help, /users, /me <action>, /nick <newname>, /clear",
            time: timestamp(),
          }));
        } else if (cmd === "/users") {
          ws.send(JSON.stringify({
            type: "system",
            message: `Online (${userList().length}): ${userList().join(", ")}`,
            time: timestamp(),
          }));
        } else if (cmd === "/me") {
          const action = parts.slice(1).join(" ") || "...";
          const actionMsg = { type: "action", username, message: `${username} ${action}`, time: timestamp() };
          chatHistory.push(actionMsg);
          if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
          broadcast(actionMsg);
        } else if (cmd === "/nick") {
          const newName = (parts[1] || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20);
          if (!newName) {
            ws.send(JSON.stringify({ type: "error", message: "Usage: /nick <newname>" }));
            return;
          }
          const taken = [...clients.values()].some((c) => c.username.toLowerCase() === newName.toLowerCase());
          if (taken) {
            ws.send(JSON.stringify({ type: "error", message: `"${newName}" is already taken.` }));
            return;
          }
          const oldName = username;
          clients.get(ws).username = newName;
          const nickMsg = { type: "system", message: `${oldName} is now known as ${newName}`, time: timestamp() };
          chatHistory.push(nickMsg);
          if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
          broadcast(nickMsg);
          broadcast({ type: "users", list: userList() });
        } else if (cmd === "/clear") {
          ws.send(JSON.stringify({ type: "clear" }));
        } else {
          ws.send(JSON.stringify({ type: "error", message: `Unknown command: ${cmd}` }));
        }
        return;
      }

      const chatMsg = { type: "chat", username, text, time: timestamp() };
      chatHistory.push(chatMsg);
      if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
      broadcast(chatMsg);
    }
  });

  ws.on("close", () => {
    if (registered) {
      const { username } = clients.get(ws);
      clients.delete(ws);
      const leaveMsg = { type: "system", message: `${username} left the room`, time: timestamp() };
      chatHistory.push(leaveMsg);
      if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
      broadcast(leaveMsg);
      broadcast({ type: "users", list: userList() });
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n  Terminal Chatroom running at http://localhost:${PORT}\n`);
});
