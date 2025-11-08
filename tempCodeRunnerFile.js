 socket.on("trackBooking", async (bookingCode) => {
    try {
      const snapshot = await get(ref(db, "drivers"));
      let found = false;

      snapshot.forEach((child) => {
        const driver = child.val();

        // Match booking1 or booking2 code
        if (driver.booking1_code === bookingCode || driver.booking2_code === bookingCode) {
          found = true;
          const info = {
            driverId: child.key,
            driverLat: driver.lat,
            driverLng: driver.lng,
            riderId:
              driver.booking1_code === bookingCode
                ? driver.rider1_id
                : driver.rider2_id,
            riderLat:
              driver.booking1_code === bookingCode
                ? driver.rider1_lat
                : driver.rider2_lat,
            riderLng:
              driver.booking1_code === bookingCode
                ? driver.rider1_lng
                : driver.rider2_lng,
            bookingCode,
            source:
              driver.booking1_code === bookingCode
                ? "rider1"
                : "rider2",
          };

          // Send back data to frontend
          socket.emit("trackResult", info);

          // ✅ Now start live updates
          socket.emit("trackLive", bookingCode);
        }
      });

      if (!found) socket.emit("trackFailed", "❌ Invalid booking code!");
    } catch (err) {
      console.error("trackBooking error:", err);
      socket.emit("trackFailed", "❌ Server error tracking booking!");
    }
  });

  // 🟢 2. Live tracking listener
  socket.on("trackLive", async (bookingCode) => {
    const driversRef = ref(db, "drivers");
    onValue(driversRef, (snapshot) => {
      snapshot.forEach((child) => {
        const d = child.val();

        // When driver or rider moves, send updates
        if (d.booking1_code === bookingCode) {
          io.to(socket.id).emit("liveDriverUpdate", { lat: d.lat, lng: d.lng });
          io.to(socket.id).emit("liveRiderUpdate", {
            lat: d.rider1_lat,
            lng: d.rider1_lng,
          });
        } else if (d.booking2_code === bookingCode) {
          io.to(socket.id).emit("liveDriverUpdate", { lat: d.lat, lng: d.lng });
          io.to(socket.id).emit("liveRiderUpdate", {
            lat: d.rider2_lat,
            lng: d.rider2_lng,
          });
        }
      });
    });
  });
