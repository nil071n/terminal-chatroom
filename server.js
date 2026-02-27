const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const clients = new Map(); // ws -> { username }
const chatHistory = [];
const MAX_HISTORY = 200;

// Simple session tokens issued by /auth
const sessions = new Map(); // token -> { pcName, created }

// Serve static HTML and auth endpoint
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/auth') {
    // accept JSON { pcName, signature }
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => {
      try {
        const obj = JSON.parse(body || '{}');
        const pcName = (obj.pcName || '').toString().slice(0,64);
        if (!pcName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'pcName required' }));
          return;
        }
        // create a simple random token
        const token = require('crypto').randomBytes(18).toString('hex');
        sessions.set(token, { pcName, created: Date.now() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token }));
      } catch (e) {
        res.writeHead(400);
        res.end('Invalid request');
      }
    });
    return;
  }

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

wss.on("connection", (ws, req) => {
  // require a token query parameter issued by /auth
  const url = req && req.url ? req.url : '';
  let token = null;
  try { token = new URL('http://x' + url).searchParams.get('token'); } catch (e) { token = null; }
  if (!token || !sessions.has(token)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Auth required: must connect using launcher token' }));
    try { ws.close(); } catch (e) {}
    return;
  }

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
