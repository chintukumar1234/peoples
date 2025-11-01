// app.js
const express = require("express");
const mysql = require("mysql");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --------------------
// MySQL Connection
// --------------------
const con = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "1234",
  database: "student",
});

con.connect((err) => {
  if (err) console.error("❌ MySQL connection error:", err);
  else console.log("✅ MySQL connected");
});

// --------------------
// Middleware & static
// --------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// --------------------
// In-memory state
// --------------------
// drivers: map driverId -> { lat, lng, online, socketId, rider1_id, rider2_id, rider1_lat, rider1_lng, rider2_lat, rider2_lng, speed, accuracy }
// riders: map riderSocketId -> { lat, lng, speed, accuracy, ts }
let drivers = {};
let riders = {};

// --------------------
// Helper: sanitize drivers for broadcasting to riders
// --------------------
function sanitizeDriversForBroadcast(driversObj) {
  const out = {};
  for (const id in driversObj) {
    const d = driversObj[id] || {};

    // Build an array of riders that are booked
    const bookedBy = [];
    if (d.rider1_id) bookedBy.push(d.rider1_id);
    if (d.rider2_id) bookedBy.push(d.rider2_id);

    out[id] = {
      lat: d.lat ?? null,
      lng: d.lng ?? null,
      online: !!d.online,
      bookedBy, // now it's an array, not boolean
      speed: d.speed ?? null,
      accuracy: d.accuracy ?? null
    };
  }
  return out;
}


// --------------------
// REST endpoints
// --------------------

// Insert driver (for testing / admin)
app.post("/insert", (req, res) => {
  const { name, gmail, password, mobile } = req.body;
  if (!name || !gmail || !password || !mobile) return res.json({ message: "All fields are required!" });

  const sql = `INSERT INTO driver (name, gmail, password, mobile) VALUES (?, ?, ?, ?)`;
  con.query(sql, [name, gmail, password, mobile], (err, result) => {
    if (err) {
      console.error("DB insert error:", err);
      return res.json({ message: "Database error!" });
    }
    res.json({ message: "Driver added!", userId: result.insertId });
  });
});

// Driver login
app.post("/loginDriver", (req, res) => {
  const { gmail, password } = req.body;
  if (!gmail || !password) return res.json({ success: false, message: "All fields are required!" });

  const sql = "SELECT * FROM driver WHERE TRIM(gmail)=? AND TRIM(password)=?";
  con.query(sql, [gmail, password], (err, results) => {
    if (err) {
      console.error("DB login error:", err);
      return res.json({ success: false, message: "Database error!" });
    }
    if (results.length > 0) {
      const user = results[0];
      res.json({ success: true, message: "Login successful!", userId: user.id, name: user.name });
    } else {
      res.json({ success: false, message: "Invalid Gmail or Password!" });
    }
  });
});

// Reconnect rider (used by rider client to check stored booking)
app.post("/reconnectRider", (req, res) => {
  const { driverId, bookingCode } = req.body;
  if (!driverId || !bookingCode) return res.json({ success: false });

  const sql = `SELECT * FROM driver WHERE id=? AND (booking1_code=? OR booking2_code=?)`;
  con.query(sql, [driverId, bookingCode, bookingCode], (err, result) => {
    if (err) {
      console.error("DB reconnect error:", err);
      return res.json({ success: false });
    }
    if (!result || result.length === 0) return res.json({ success: false });
    // return the stored rider lat/lng if available
    const row = result[0];
    res.json({ success: true, rider1_id: row.rider1_id, rider1_lat: row.rider1_lat, rider1_lng: row.rider1_lng, rider2_id: row.rider2_id, rider2_lat: row.rider2_lat, rider2_lng: row.rider2_lng });
  });
});

// Target / finish ride (driver UI calls to clear booking using booking code)
app.post("/target", (req, res) => {
  const { bookingCode } = req.body;

  if (!bookingCode) {
    return res.status(400).json({ error: "Missing booking code" });
  }

  const sql1 = `
    UPDATE driver 
    SET rider1_id = NULL, 
        booking1_code = NULL, 
        rider1_created_at = NULL, 
        rider1_lat = NULL, 
        rider1_lng = NULL 
    WHERE booking1_code = ?`;

  const sql2 = `
    UPDATE driver 
    SET rider2_id = NULL, 
        booking2_code = NULL, 
        rider2_created_at = NULL, 
        rider2_lat = NULL, 
        rider2_lng = NULL 
    WHERE booking2_code = ?`;

  con.query(sql1, [bookingCode], (err, result1) => {
    if (err) {
      console.error("DB error (booking1):", err);
      return res.status(500).json({ error: "Database error (booking1)" });
    }

    if (result1.affectedRows > 0) {
      console.log("✅ Cleared booking1 data");
      // also clear in-memory drivers state where matching booking exists
      for (const id in drivers) {
        if (drivers[id] && drivers[id].booking1_code === bookingCode) {
          drivers[id].rider1_id = null;
          drivers[id].booking1_code = null;
          drivers[id].rider1_lat = null;
          drivers[id].rider1_lng = null;
        }
      }
      return res.json({ message: "Booking 1 cleared successfully!" });
    }

    con.query(sql2, [bookingCode], (err, result2) => {
      if (err) {
        console.error("DB error (booking2):", err);
        return res.status(500).json({ error: "Database error (booking2)" });
      }

      if (result2.affectedRows > 0) {
        console.log("✅ Cleared booking2 data");
        for (const id in drivers) {
          if (drivers[id] && drivers[id].booking2_code === bookingCode) {
            drivers[id].rider2_id = null;
            drivers[id].booking2_code = null;
            drivers[id].rider2_lat = null;
            drivers[id].rider2_lng = null;
          }
        }
        return res.json({ message: "Booking 2 cleared successfully!" });
      }

      console.log("⚠️ No matching booking found");
      res.json({ message: "No booking found for this code" });
    });
  });
});

// Update online flag from driver client
app.post("/updateOnline", (req, res) => {
  const { userId, online } = req.body;
  if (!userId) return res.status(400).json({ success: false, message: "Missing userId" });

  const val = online ? 1 : 0;
  con.query("UPDATE driver SET online=? WHERE id=?", [val, userId], (err) => {
    if (err) {
      console.error("DB error updating online:", err);
      return res.status(500).json({ success: false, message: "DB error" });
    }
    if (drivers[userId]) drivers[userId].online = val;
    return res.json({ success: true });
  });
});

// --------------------
// Socket.IO realtime
// --------------------
io.on("connection", (socket) => {
  console.log("🟢 Socket connected:", socket.id);

  // Register driver (sent from driver client on connect)
  socket.on("registerDriver", ({ driverId }) => {
    if (!driverId) return;
    socket.driverId = driverId;
    drivers[driverId] = drivers[driverId] || { bookedBy: null, online: 1 };
    drivers[driverId].socketId = socket.id;
    drivers[driverId].online = 1;

    // Load last known data from DB
    con.query("SELECT * FROM driver WHERE id=?", [driverId], (err, results) => {
      if (!err && results && results.length > 0) {
        const d = results[0];
        drivers[driverId].lat = d.lat;
        drivers[driverId].lng = d.lng;
        drivers[driverId].rider1_id = d.rider1_id;
        drivers[driverId].rider2_id = d.rider2_id;
        drivers[driverId].rider1_lat = d.rider1_lat;
        drivers[driverId].rider1_lng = d.rider1_lng;
        drivers[driverId].rider2_lat = d.rider2_lat;
        drivers[driverId].rider2_lng = d.rider2_lng;
        drivers[driverId].booking1_code = d.booking1_code;
        drivers[driverId].booking2_code = d.booking2_code;
        drivers[driverId].bookedBy = !!(d.rider1_id || d.rider2_id);

        // If driver has active riders, notify them (driver UI needs bookingConfirmed)
        if (d.rider1_id) socket.emit("bookingConfirmed", {
          riderId: d.rider1_id,
          lat: d.rider1_lat,
          lng: d.rider1_lng,
          bookingCode: d.booking1_code || null, // ✅ added
        });

        if (d.rider2_id) socket.emit("bookingConfirmed", {
          riderId: d.rider2_id,
          lat: d.rider2_lat,
          lng: d.rider2_lng,
          bookingCode: d.booking2_code || null, // ✅ added
        });
      }
    });
  });

  // Driver shares location
  socket.on("driverLocation", ({ lat, lng, speed, accuracy }) => {
    const id = socket.driverId;
    if (!id) return;
    drivers[id] = { ...drivers[id], lat, lng, speed, accuracy, online: 1, socketId: socket.id };
    // Persist driver location to DB (non-blocking)
    con.query("UPDATE driver SET lat=?, lng=? WHERE id=?", [lat, lng, id], (err) => {
      if (err) console.error("DB update driver location error:", err);
    });
  });

  // Rider shares location
  socket.on("riderLocation", (pos) => {
    // pos should have lat,lng,speed,accuracy,ts optionally
    riders[socket.id] = { ...pos, id: socket.id };

    // Find driver who has booked this rider (in-memory)
    const driverId = Object.keys(drivers).find(d => drivers[d] && (drivers[d].rider1_id === socket.id || drivers[d].rider2_id === socket.id));
    if (driverId) {
      let colLat = "", colLng = "";
      if (drivers[driverId].rider1_id === socket.id) { colLat = "rider1_lat"; colLng = "rider1_lng"; }
      else { colLat = "rider2_lat"; colLng = "rider2_lng"; }

      // Update DB for rider lat/lng
      con.query(`UPDATE driver SET ${colLat}=?, ${colLng}=? WHERE id=?`, [pos.lat, pos.lng, driverId], (err) => {
        if (err) console.error("DB update rider position error:", err);
      });

      // Update in-memory
      if (drivers[driverId]) {
        if (drivers[driverId].rider1_id === socket.id) {
          drivers[driverId].rider1_lat = pos.lat;
          drivers[driverId].rider1_lng = pos.lng;
        } else {
          drivers[driverId].rider2_lat = pos.lat;
          drivers[driverId].rider2_lng = pos.lng;
        }
      }

      // emit to the specific driver socket
      if (drivers[driverId] && drivers[driverId].socketId) {
        io.to(drivers[driverId].socketId).emit("riderPositionUpdate", { riderId: socket.id, lat: pos.lat, lng: pos.lng });
      }
    }
  });

  socket.on("bookDriver", (driverId) => {
  const driver = drivers[driverId];
  const rider = riders[socket.id];
  if (!driver) return socket.emit("bookingFailed", "Driver not found");
  if (!rider) return socket.emit("bookingFailed", "Your location not found. Wait for GPS and try again.");

  // ✅ If driver1 is booked, then book rider2 automatically
  let slot;
  if (!driver.rider1_id) slot = "rider1_id";
  else if (!driver.rider2_id) slot = "rider2_id";
  else return socket.emit("bookingFailed", "Driver full");

  const bookingSlot = slot === "rider1_id" ? "booking1_code" : "booking2_code";
  const createdSlot = slot === "rider1_id" ? "rider1_created_at" : "rider2_created_at";
  const driverLatCol = slot === "rider1_id" ? "rider1_lat" : "rider2_lat";
  const driverLngCol = slot === "rider1_id" ? "rider1_lng" : "rider2_lng";
  const bookingCode = Math.random().toString(36).substring(2, 8).toUpperCase();

  // Update database with booking info
  const sql = `UPDATE driver SET ${slot}=?, ${bookingSlot}=?, ${createdSlot}=NOW(), ${driverLatCol}=?, ${driverLngCol}=? WHERE id=?`;
  con.query(sql, [socket.id, bookingCode, rider.lat || null, rider.lng || null, driverId], (err) => {
    if (err) {
      console.error("DB error booking:", err);
      return socket.emit("bookingFailed", "Database error");
    }

    // Update in-memory driver state
    drivers[driverId] = drivers[driverId] || {};
    drivers[driverId][slot] = socket.id;
    drivers[driverId][bookingSlot] = bookingCode;
    drivers[driverId][driverLatCol] = rider.lat || null;
    drivers[driverId][driverLngCol] = rider.lng || null;
    drivers[driverId].bookedBy = !!(drivers[driverId].rider1_id || drivers[driverId].rider2_id);

    // Notify rider and driver
    socket.emit("bookingSuccess", { driverId, bookingCode, slot });

    // ✅ Send to driver with bookingCode
    if (drivers[driverId].socketId) {
      io.to(drivers[driverId].socketId).emit("bookingConfirmed", {
        riderId: socket.id,
        lat: rider.lat,
        lng: rider.lng,
        bookingCode// include bookingCode here
      });
    }
  });
});

// ✅ Track driver & rider using booking code (DB + memory fallback)
socket.on("trackBooking", (bookingCode) => {
  if (!bookingCode) return socket.emit("trackFailed", "Booking code missing");

  // First, try from in-memory (fastest)
  let foundDriverId = Object.keys(drivers).find(d => {
    const drv = drivers[d];
    return drv && (drv.booking1_code === bookingCode || drv.booking2_code === bookingCode);
  });

  if (foundDriverId) {
    const driver = drivers[foundDriverId];
    let riderId, riderLat, riderLng;
    if (driver.booking1_code === bookingCode) {
      riderId = driver.rider1_id;
      riderLat = driver.rider1_lat;
      riderLng = driver.rider1_lng;
    } else {
      riderId = driver.rider2_id;
      riderLat = driver.rider2_lat;
      riderLng = driver.rider2_lng;
    }

    socket.emit("trackResult", {
      driverId: foundDriverId,
      driverLat: driver.lat,
      driverLng: driver.lng,
      riderId,
      riderLat,
      riderLng,
      bookingCode,
      source: "memory"
    });
    return;
  }

  // 🔍 If not in memory, search database
  const sql = `
    SELECT id AS driverId, lat AS driverLat, lng AS driverLng,
           rider1_id, rider1_lat, rider1_lng, booking1_code,
           rider2_id, rider2_lat, rider2_lng, booking2_code
    FROM driver
    WHERE booking1_code = ? OR booking2_code = ?
    LIMIT 1
  `;
  con.query(sql, [bookingCode, bookingCode], (err, results) => {
    if (err) {
      console.error("DB track error:", err);
      return socket.emit("trackFailed", "Database error");
    }

    if (!results || results.length === 0) {
      return socket.emit("trackFailed", "Booking not found");
    }

    const d = results[0];
    let riderId, riderLat, riderLng;
    if (d.booking1_code === bookingCode) {
      riderId = d.rider1_id;
      riderLat = d.rider1_lat;
      riderLng = d.rider1_lng;
    } else {
      riderId = d.rider2_id;
      riderLat = d.rider2_lat;
      riderLng = d.rider2_lng;
    }

    // Send response
    socket.emit("trackResult", {
      driverId: d.driverId,
      driverLat: d.driverLat,
      driverLng: d.driverLng,
      riderId,
      riderLat,
      riderLng,
      bookingCode,
      source: "database"
    });
  });
});
// ✅ Live tracking by booking code
socket.on("trackLive", (bookingCode) => {
  if (!bookingCode) return;

  // Store mapping: which socket is tracking which booking
  socket.trackingBookingCode = bookingCode;
  console.log("📡 Tracking live for code:", bookingCode);
});

// ✅ When driver updates location — also send to any trackers
socket.on("driverLocation", ({ lat, lng, speed, accuracy }) => {
  const id = socket.driverId;
  if (!id) return;
  drivers[id] = { ...drivers[id], lat, lng, speed, accuracy, online: 1, socketId: socket.id };

  // Update DB
  con.query("UPDATE driver SET lat=?, lng=? WHERE id=?", [lat, lng, id], (err) => {
    if (err) console.error("DB update driver location error:", err);
  });

  // ✅ Send to all clients who are tracking this driver's booking(s)
  io.sockets.sockets.forEach((client) => {
    const code = client.trackingBookingCode;
    if (!code) return;
    const d = drivers[id];
    if (d && (d.booking1_code === code || d.booking2_code === code)) {
      client.emit("liveDriverUpdate", { lat, lng, driverId: id });
    }
  });
});

// ✅ When rider updates location — also send to any trackers
socket.on("riderLocation", (pos) => {
  riders[socket.id] = { ...pos, id: socket.id };

  const driverId = Object.keys(drivers).find(d => drivers[d] && 
    (drivers[d].rider1_id === socket.id || drivers[d].rider2_id === socket.id)
  );
  if (!driverId) return;

  const driver = drivers[driverId];
  let colLat = "", colLng = "";
  if (driver.rider1_id === socket.id) { colLat = "rider1_lat"; colLng = "rider1_lng"; }
  else { colLat = "rider2_lat"; colLng = "rider2_lng"; }

  con.query(`UPDATE driver SET ${colLat}=?, ${colLng}=? WHERE id=?`, [pos.lat, pos.lng, driverId], (err) => {
    if (err) console.error("DB update rider position error:", err);
  });

  driver[colLat] = pos.lat;
  driver[colLng] = pos.lng;

  if (driver.socketId) {
    io.to(driver.socketId).emit("riderPositionUpdate", { riderId: socket.id, lat: pos.lat, lng: pos.lng });
  }

  // ✅ Notify all tracking clients
  io.sockets.sockets.forEach((client) => {
    const code = client.trackingBookingCode;
    if (!code) return;
    if (driver.booking1_code === code || driver.booking2_code === code) {
      client.emit("liveRiderUpdate", { lat: pos.lat, lng: pos.lng, riderId: socket.id });
    }
  });
});

});

// --------------------
// Broadcast sanitized drivers periodically
// --------------------
setInterval(() => {
  const payload = sanitizeDriversForBroadcast(drivers);
  io.emit("updateDrivers", payload);
}, 1000);

// --------------------
// Start server
// --------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
