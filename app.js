// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import bodyParser from "body-parser";
import cors from "cors";
import { initializeApp } from "firebase/app";
import path from "path";
import { fileURLToPath } from "url";
import {
  getDatabase,
  ref,
  set,
  get,
  push,
  update,
} from "firebase/database";

/* ========== Firebase Config (your config kept) ========== */
const firebaseConfig = {
  apiKey: "AIzaSyCsZcn4VPhpnlgU0K_NPHPINjq9Qi5iVT8",
  authDomain: "mydatabase-e7c01.firebaseapp.com",
  databaseURL: "https://mydatabase-e7c01-default-rtdb.firebaseio.com",
  projectId: "mydatabase-e7c01",
  storageBucket: "mydatabase-e7c01.firebasestorage.app",
  messagingSenderId: "447471871540",
  appId: "1:447471871540:web:d48721caa65174b1598c61",
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

/* ========== Express + Socket.IO setup ========== */
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

/* ========== In-memory mappings ========== */
/*
  drivers[driverId] = {
    socketId: "<socket.id>",
    online: 1,
    ...optional cached fields...
  }
*/
let drivers = {};
let riders = {}; // optional if you want to store rider sockets later

/* ========== API Routes (kept /insert, /login, /updateOnline, /target, /show) ========== */

// Add driver
app.post("/insert", async (req, res) => {
  try {
    const { name, gmail, password, mobile, lat, lng } = req.body;
    if (!name || !gmail || !password || !mobile) {
      return res.status(400).send("All fields are required.");
    }

    const newDriverRef = push(ref(db, "drivers"));
    await set(newDriverRef, {
      name,
      gmail,
      password,
      mobile,
      online: 1,
      // Rider1
      Rider1_id: null,
      Booking1_code: null,
      Rider1_created_at: null,
      Rider1_lat: null,
      Rider1_lng: null,
      Rider1_pickup: null,
      Rider1_destination: null,
      // Rider2
      Rider2_id: null,
      Booking2_code: null,
      Rider2_created_at: null,
      Rider2_lat: null,
      Rider2_lng: null,
      Rider2_pickup: null,
      Rider2_destination: null,
      // Driver loc
      Driver_lat: lat || null,
      Driver_lng: lng || null,
    });

    res.json({
      message: "✅ Driver added successfully!",
      driverId: newDriverRef.key,
    });
  } catch (e) {
    console.error("❌ Error adding driver:", e);
    res.status(500).json({ message: "Server error", error: e.message });
  }
});

// Show online drivers
app.post("/show", async (req, res) => {
  try {
    const snap = await get(ref(db, "drivers"));
    let onlineDrivers = [];
    snap.forEach((child) => {
      const driver = child.val();
      if (driver.online === 1) onlineDrivers.push({ id: child.key, ...driver });
    });
    res.json({ count: onlineDrivers.length, drivers: onlineDrivers });
  } catch (e) {
    console.error("❌ Error fetching drivers:", e);
    res.status(500).json({ message: "Server error" });
  }
});

// Login
app.post("/login", async (req, res) => {
  try {
    const { gmail, password } = req.body;
    const snap = await get(ref(db, "drivers"));
    const allDrivers = snap.val() || {};
    let user = null;
    for (let id in allDrivers) {
      const d = allDrivers[id];
      if (d.gmail === gmail && d.password === password) {
        user = { id, ...d };
        break;
      }
    }
    if (!user) return res.json({ error: "Invalid email or password" });
    res.json({ message: "Login successful", loggedInUser: user });
  } catch (e) {
    console.error("❌ Login error:", e);
    res.status(500).json({ message: "Server error" });
  }
});

// Update online flag
app.post("/updateOnline", async (req, res) => {
  try {
    const { userId, online } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: "Missing userId" });
    await update(ref(db, `drivers/${userId}`), { online: online ? 1 : 0 });
    res.json({ success: true });
  } catch (e) {
    console.error("❌ Update online error:", e);
    res.status(500).json({ success: false });
  }
});

// Clear booking by bookingCode
app.post("/target", async (req, res) => {
  try {
    const { bookingCode } = req.body;
    if (!bookingCode) return res.status(400).json({ message: "Booking code is required!" });

    const snapshot = await get(ref(db, "drivers"));
    if (!snapshot.exists()) return res.status(404).json({ message: "No drivers found!" });

    let cleared = false;
    snapshot.forEach((child) => {
      const driverDb = child.val();
      const driverKey = child.key;
      const driverRef = ref(db, `drivers/${driverKey}`);

      if (driverDb.Booking1_code === bookingCode) {
        update(driverRef, {
          Booking1_code: null,
          Rider1_id: null,
          Rider1_created_at: null,
          Rider1_lat: null,
          Rider1_lng: null,
          Rider1_destination: null,
          Rider1_pickup: null,
        });
        // notify connected driver via in-memory mapping or room
        if (drivers[driverKey]?.socketId) io.to(driverKey).emit("bookingCleared", { bookingCode });
        cleared = true;
      } else if (driverDb.Booking2_code === bookingCode) {
        update(driverRef, {
          Booking2_code: null,
          Rider2_id: null,
          Rider2_created_at: null,
          Rider2_lat: null,
          Rider2_lng: null,
          Rider2_destination: null,
          Rider2_pickup: null,
        });
        if (drivers[driverKey]?.socketId) io.to(driverKey).emit("bookingCleared", { bookingCode });
        cleared = true;
      }
    });

    if (cleared) res.json({ message: "Booking cleared successfully!" });
    else res.status(404).json({ message: "No matching booking code found!" });
  } catch (e) {
    console.error("❌ Error clearing booking:", e);
    res.status(500).json({ message: "Server error clearing booking!" });
  }
});

/* ========== Test route: emit a fake riderPositionUpdate to driverId ==========
   POST /testEmit { driverId, riderId, lat, lng }
   Use this to quickly verify driver receives event.
=============================================================== */
app.post("/testEmit", (req, res) => {
  const { driverId, riderId, lat, lng } = req.body;
  if (!driverId || !riderId) return res.status(400).json({ message: "driverId & riderId required" });

  if (drivers[driverId]?.socketId) {
    io.to(driverId).emit("riderPositionUpdate", { riderId, lat: Number(lat) || 0, lng: Number(lng) || 0 });
    return res.json({ message: "Emitted to driver room", driverId });
  } else {
    return res.status(404).json({ message: "Driver not connected in-memory", driverId });
  }
});

/* ========== Socket.IO events ========== */
io.on("connection", (socket) => {
  // Driver registration: must be called from driver frontend after login:
  // socket.emit("registerDriver", { driverId })
  socket.on("registerDriver", async ({ driverId }) => {
    try {
      if (!driverId) return;
      socket.driverId = driverId;

      // Join a room named by driverId so we can use io.to(driverId).emit(...)
      socket.join(driverId);
      // Mark in-memory mapping
      // Keep existing cached fields if present
      drivers[driverId] = { ...(drivers[driverId] || {}), socketId: socket.id, online: 1 };

      // Update DB online flag (best-effort)
      try { await update(ref(db, `drivers/${driverId}`), { online: 1 }); } catch (e) {}

      // If driver has active bookings in DB, send them
      const snap = await get(ref(db, `drivers/${driverId}`));
      if (snap.exists()) {
        const d = snap.val();
        if (d.Rider1_id) socket.emit("bookingConfirmed", { riderId: d.Rider1_id, lat: d.Rider1_lat, lng: d.Rider1_lng, bookingCode: d.Booking1_code });
        if (d.Rider2_id) socket.emit("bookingConfirmed", { riderId: d.Rider2_id, lat: d.Rider2_lat, lng: d.Rider2_lng, bookingCode: d.Booking2_code });
      }
    } catch (e) {
      console.error("Error in registerDriver:", e);
    }
  });

  // Driver sends live location to backend
  socket.on("driverLocation", async ({ lat, lng, speed, accuracy }) => {
    if (!socket.driverId) return;
    // create memory entry if missing
    if (!drivers[socket.driverId]) drivers[socket.driverId] = { socketId: socket.id };

    drivers[socket.driverId].Driver_lat = lat;
    drivers[socket.driverId].Driver_lng = lng;

    try {
      await update(ref(db, `drivers/${socket.driverId}`), { Driver_lat: lat, Driver_lng: lng });
    } catch (e) {
      console.warn("Failed to update driver location in DB:", e.message);
    }
  });

  // Rider sends live location (rider app emits this)
  // Backend checks DB to find which driver has this rider booked and forwards update
  socket.on("riderLiveLocation", async ({ riderId, lat, lng }) => {
    if (!riderId || typeof lat !== "number" || typeof lng !== "number") {
      console.warn("Invalid riderLiveLocation payload:", { riderId, lat, lng });
      return;
    }

    // Read DB snapshot (authoritative mapping of riders -> drivers)
    const snap = await get(ref(db, "drivers"));
    const dbDrivers = snap.val();
    if (!dbDrivers) {
      console.warn("No drivers in DB");
      return;
    }

    // Iterate DB drivers to find which driver contains this rider
    for (let driverId in dbDrivers) {
      const driverDb = dbDrivers[driverId];

      // SLOT 1
      if (driverDb.Rider1_id === riderId) {
        // update DB
        try { await update(ref(db, `drivers/${driverId}`), { Rider1_lat: lat, Rider1_lng: lng }); } catch (e) {}
        // emit to driver room (driver joined room on register)
        if (drivers[driverId]?.socketId) {
          io.to(driverId).emit("riderPositionUpdate", { riderId, lat, lng });
        }
        return;
      }

      // SLOT 2
      if (driverDb.Rider2_id === riderId) {
        try { await update(ref(db, `drivers/${driverId}`), { Rider2_lat: lat, Rider2_lng: lng }); } catch (e) {}
        if (drivers[driverId]?.socketId) {
          io.to(driverId).emit("riderPositionUpdate", { riderId, lat, lng });
        }
        return;
      }
    }
  });

  // Booking flow (rider requests booking)
  socket.on("bookDriver", async (data) => {
    try {
      if (!data.driverId || !data.riderId) {
        return socket.emit("bookingStatus", { status: "error", message: "Driver or Rider ID missing" });
      }

      const driverRef = ref(db, `drivers/${data.driverId}`);
      const snap = await get(driverRef);
      const driver = snap.val();
      if (!driver) return socket.emit("bookingStatus", { status: "error", message: "Driver not found" });

      let slot = null;
      if (!driver.Rider1_id) slot = "slot1";
      else if (!driver.Rider2_id) slot = "slot2";
      else return socket.emit("bookingFailed", "Driver full");

      const bookingCode = Math.floor(100000 + Math.random() * 900000).toString();
      const now = data.createdAt || Date.now();
      const updateData = slot === "slot1"
        ? { Rider1_id: data.riderId, Booking1_code: bookingCode, Rider1_created_at: now, Rider1_lat: data.lat || null, Rider1_lng: data.lng || null, Rider1_pickup: data.pickup || null, Rider1_destination: data.destination || null }
        : { Rider2_id: data.riderId, Booking2_code: bookingCode, Rider2_created_at: now, Rider2_lat: data.lat || null, Rider2_lng: data.lng || null, Rider2_pickup: data.pickup || null, Rider2_destination: data.destination || null };

      await update(driverRef, updateData);

      socket.emit("bookingStatus", { status: "success", slot, driverId: data.driverId });
      socket.emit("bookingSuccess", { driverId: data.driverId, bookingData: { bookingCode, slot, lat: data.lat, lng: data.lng, createdAt: now } });

      // notify driver room if connected
      if (drivers[data.driverId]?.socketId) {
        io.to(data.driverId).emit("bookingConfirmed", { riderId: data.riderId, lat: data.lat, lng: data.lng, bookingCode });
        console.log(`📣 Notified driver ${data.driverId} of new booking`);
      }
    } catch (e) {
      console.error("Error in bookDriver:", e);
      socket.emit("bookingStatus", { status: "error", message: "Server error" });
    }
  });

  socket.on("disconnect", async () => {
  if (socket.driverId) {
    const driverId = socket.driverId;  // store before resetting
    // keep online = 1 (your requirement)
    await update(ref(db, `drivers/${driverId}`), { online: 1 });
    // remove from in-memory store
    delete drivers[driverId];
  }
});
});
/* ========== Start server ========== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));
