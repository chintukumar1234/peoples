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
  child,
  onValue
} from "firebase/database";
const app = express();
// --------------------
// 🔥 Firebase Config
// --------------------
const firebaseConfig = {
  apiKey: "AIzaSyCsZcn4VPhpnlgU0K_NPHPINjq9Qi5iVT8",
  authDomain: "mydatabase-e7c01.firebaseapp.com",
  databaseURL: "https://mydatabase-e7c01-default-rtdb.firebaseio.com",
  projectId: "mydatabase-e7c01",
  storageBucket: "mydatabase-e7c01.firebasestorage.app",
  messagingSenderId: "447471871540",
  appId: "1:447471871540:web:d48721caa65174b1598c61",
  measurementId: "G-80M4PND75H"
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 👇 Serve all files from the "public" folder
app.use(express.static(path.join(__dirname, "public")));

// Optional: Handle default route (serves index.html automatically)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
// --------------------
// Express + Socket.IO Setup
// --------------------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(bodyParser.json());

// --------------------
// In-memory state
// --------------------
let drivers = {};
let riders = {};

// --------------------
// Helper
// --------------------
function sanitizeDriversForBroadcast(driversObj) {
  const out = {};
  for (const id in driversObj) {
    const d = driversObj[id] || {};
    const bookedBy = [];
    if (d.rider1_id) bookedBy.push(d.rider1_id);
    if (d.rider2_id) bookedBy.push(d.rider2_id);
    out[id] = {
      lat: d.lat ?? null,
      lng: d.lng ?? null,
      online: !!d.online,
      bookedBy,
      speed: d.speed ?? null,
      accuracy: d.accuracy ?? null,
    };
  }
  return out;
}

// --------------------
// REST API Endpoints
// --------------------

// Insert driver
app.post("/insert", async (req, res) => {
  try {
    const { name, gmail, password, mobile ,lat, lng} = req.body;

    if (!name || !gmail || !password || !mobile) {
      return res.status(400).json({ message: "All fields are required!" });
    }

    // Create new driver entry with default fields
    const newDriverRef = push(ref(db, "drivers"));
    await set(newDriverRef, {
      name,
      gmail,
      password,
      mobile,
      online: 1,

      // Rider 1 details
      rider1_id: null,
      booking1_code: null,
      rider1_created_at: null,
      rider1_lat: null,
      rider1_lng: null,

      // Rider 2 details
      rider2_id: null,
      booking2_code: null,
      rider2_created_at: null,
      rider2_lat: null,
      rider2_lng: null,

      // Driver location
      lat: null,
      lng: null,
    });

    res.json({
      message: "✅ Driver added successfully!",
      driverId: newDriverRef.key,
    });
  } catch (error) {
    console.error("❌ Error adding driver:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// Driver login
app.post("/loginDriver", async (req, res) => {
  const { gmail, password } = req.body;
  if (!gmail || !password)
    return res.json({ success: false, message: "All fields are required!" });

  const snapshot = await get(ref(db, "drivers"));
  if (snapshot.exists()) {
    const driversData = snapshot.val();
    for (const id in driversData) {
      const d = driversData[id];
      if (d.gmail.trim() === gmail.trim() && d.password.trim() === password.trim()) {
        return res.json({
          success: true,
          message: "Login successful!",
          userId: id,
          name: d.name,
        });
      }
    }
  }
  res.json({ success: false, message: "Invalid Gmail or Password!" });
});

// Update driver online status
app.post("/updateOnline", async (req, res) => {
  const { userId, online } = req.body;
  if (!userId)
    return res
      .status(400)
      .json({ success: false, message: "Missing userId" });

  await update(ref(db, `drivers/${userId}`), { online: online ? 1 : 0 });
  res.json({ success: true });
});

app.post("/target", async (req, res) => {
  try {
    const { bookingCode } = req.body;

    if (!bookingCode)
      return res.status(400).json({ message: "Booking code is required!" });

    const driversRef = ref(db, "drivers");
    const snapshot = await get(driversRef);

    if (!snapshot.exists())
      return res.status(404).json({ message: "No drivers found!" });

    let cleared = false;

    snapshot.forEach((child) => {
      const driver = child.val();
      const driverRef = ref(db, `drivers/${child.key}`);

      // Match booking code with either booking1_code or booking2_code
      if (driver.booking1_code === bookingCode) {
        update(driverRef, {
          booking1_code: null,
          rider1_id: null,
          rider1_created_at: null,
          rider1_lat: null,
          rider1_lng: null,
        });
        cleared = true;
      } else if (driver.booking2_code === bookingCode) {
        update(driverRef, {
          booking2_code: null,
          rider2_id: null,
          rider2_created_at: null,
          rider2_lat: null,
          rider2_lng: null,
        });
        cleared = true;
      }
    });

    if (cleared) {
      res.json({ message: "Booking cleared successfully!" });
    } else {
      res.status(404).json({ message: "No matching booking code found!" });
    }
  } catch (err) {
    console.error("❌ Error clearing booking:", err);
    res.status(500).json({ message: "Server error clearing booking!" });
  }
});
// --------------------
// Socket.IO Realtime Events
// --------------------
io.on("connection", (socket) => {
  console.log("🟢 Socket connected:", socket.id); 

  // Register driver
  socket.on("registerDriver", async ({ driverId }) => {
    if (!driverId) return;
    socket.driverId = driverId;

    // Load from Firebase
    const snap = await get(ref(db, `drivers/${driverId}`));
    if (snap.exists()) {
      const d = snap.val();
      drivers[driverId] = {
        socketId: socket.id,
        online: 1,
        lat: d.lat,
        lng: d.lng,
        rider1_id: d.rider1_id,
        rider2_id: d.rider2_id,
        booking1_code: d.booking1_code,
        booking2_code: d.booking2_code,
        rider1_lat: d.rider1_lat,
        rider1_lng: d.rider1_lng,
        rider2_lat: d.rider2_lat,
        rider2_lng: d.rider2_lng,
      };

      // Send bookings back if any active
      if (d.rider1_id)
        socket.emit("bookingConfirmed", {
          riderId: d.rider1_id,
          lat: d.rider1_lat,
          lng: d.rider1_lng,
          bookingCode: d.booking1_code,
        });

      if (d.rider2_id)
        socket.emit("bookingConfirmed", {
          riderId: d.rider2_id,
          lat: d.rider2_lat,
          lng: d.rider2_lng,
          bookingCode: d.booking2_code,
        });
    }
  });

  // Driver location update
  socket.on("driverLocation", async ({ lat, lng, speed, accuracy }) => {
    const id = socket.driverId;
    if (!id) return;
    drivers[id] = { ...drivers[id], lat, lng, speed, accuracy, online: 1 };
    await update(ref(db, `drivers/${id}`), { lat, lng });
  });

  // Rider location update
  socket.on("riderLocation", async (pos) => {
    riders[socket.id] = { ...pos, id: socket.id };
    const driverId = Object.keys(drivers).find(
      (d) =>
        drivers[d] &&
        (drivers[d].rider1_id === socket.id ||
          drivers[d].rider2_id === socket.id)
    );
    if (!driverId) return;
    const driver = drivers[driverId];

    let latKey = "",
      lngKey = "";
    if (driver.rider1_id === socket.id) {
      latKey = "rider1_lat";
      lngKey = "rider1_lng";
    } else {
      latKey = "rider2_lat";
      lngKey = "rider2_lng";
    }

    await update(ref(db, `drivers/${driverId}`), {
      [latKey]: pos.lat,
      [lngKey]: pos.lng,
    });

    driver[latKey] = pos.lat;
    driver[lngKey] = pos.lng;

    if (driver.socketId) {
      io.to(driver.socketId).emit("riderPositionUpdate", {
        riderId: socket.id,
        lat: pos.lat,
        lng: pos.lng,
      });
    }
  });

  // Rider books driver
  socket.on("bookDriver", async (driverId) => {
    const driver = drivers[driverId];
    const rider = riders[socket.id];
    if (!driver)
      return socket.emit("bookingFailed", "Driver not found or offline");
    if (!rider)
      return socket.emit(
        "bookingFailed",
        "Your location not found. Wait for GPS and try again."
      );

    let slot;
    if (!driver.rider1_id) slot = "rider1_id";
    else if (!driver.rider2_id) slot = "rider2_id";
    else return socket.emit("bookingFailed", "Driver full");

    const bookingSlot = slot === "rider1_id" ? "booking1_code" : "booking2_code";
    const latCol = slot === "rider1_id" ? "rider1_lat" : "rider2_lat";
    const lngCol = slot === "rider1_id" ? "rider1_lng" : "rider2_lng";
    const bookingCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    await update(ref(db, `drivers/${driverId}`), {
      [slot]: socket.id,
      [bookingSlot]: bookingCode,
      [latCol]: rider.lat || null,
      [lngCol]: rider.lng || null,
      online: 1,
    });

    drivers[driverId][slot] = socket.id;
    drivers[driverId][bookingSlot] = bookingCode;
    drivers[driverId][latCol] = rider.lat;
    drivers[driverId][lngCol] = rider.lng;

    socket.emit("bookingSuccess", { driverId, bookingCode, slot });

    if (driver.socketId) {
      io.to(driver.socketId).emit("bookingConfirmed", {
        riderId: socket.id,
        lat: rider.lat,
        lng: rider.lng,
        bookingCode,
      });
    }
  });

  // Driver disconnect
  socket.on("disconnect", async () => {
    console.log("🔴 Socket disconnected:", socket.id);
    if (socket.driverId) {
      await update(ref(db, `drivers/${socket.driverId}`), { online: 0 });
      delete drivers[socket.driverId];
    }
  });
});

// --------------------
// Broadcast to Riders Periodically
// --------------------
setInterval(() => {
  const payload = sanitizeDriversForBroadcast(drivers);
  io.emit("updateDrivers", payload);
}, 1000);

// --------------------
// Start Server
// --------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);
