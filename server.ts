import { Server, Socket } from "socket.io";
import * as mediasoup from "mediasoup";

const io = new Server(4000, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

interface Room {
  router: mediasoup.types.Router;
  peers: string[];
  producers: { [socketId: string]: mediasoup.types.Producer[] }; // 배열로 변경
  sendTransports: { [socketId: string]: mediasoup.types.WebRtcTransport[] }; // 배열로 변경
  recvTransports: { [socketId: string]: mediasoup.types.WebRtcTransport[] }; // 배열로 변경
}

let rooms: { [roomId: string]: Room } = {};
let worker: mediasoup.types.Worker;

const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2100,
  })
  console.log(`worker pid ${worker.pid}`)

  worker.on('died', error => {
    console.error('mediasoup worker has died')
    setTimeout(() => process.exit(1), 2000) // exit in 2 seconds
  })

  return worker
}

const initWorker = async () => {
  worker = await createWorker();
  return worker;
}

initWorker();

const createWebRtcTransport = (
  router: mediasoup.types.Router,
  socketId: string,
  streamType: string // 스트림 종류 추가
): Promise<mediasoup.types.WebRtcTransport> => {
  return new Promise(async (resolve, reject) => {
    try {
      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: "127.0.0.1", announcedIp: undefined }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        appData: { socketId, streamType }, // 스트림 종류 저장
      });
      resolve(transport);
    } catch (err) {
      reject(err);
    }
  });
};

io.on("connection", (socket: Socket) => {
  console.log("Client connected:", socket.id);

  socket.on("join-room", async ({ roomId }: { roomId: string }) => {
    if (!rooms[roomId]) {
      const router = await worker.createRouter({
        mediaCodecs: [
          { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
          { kind: "video", mimeType: "video/VP8", clockRate: 90000 },
        ],
      });
      rooms[roomId] = {
        router,
        peers: [],
        producers: {},
        sendTransports: {},
        recvTransports: {},
      };
    }

    rooms[roomId].peers.push(socket.id);
    rooms[roomId].producers[socket.id] = [];
    rooms[roomId].sendTransports[socket.id] = [];
    rooms[roomId].recvTransports[socket.id] = [];
    socket.join(roomId);
    socket.emit("joined-room", { roomId });
  });

  socket.on(
    "get-rtp-capabilities",
    ({ roomId }: { roomId: string }, callback: (rtpCapabilities?: mediasoup.types.RtpCapabilities) => void) => {
      if (rooms[roomId]) {
        callback(rooms[roomId].router.rtpCapabilities);
      } else {
        callback();
      }
    }
  );

  socket.on(
    "create-transport",
    async (
      { roomId, direction, streamType }: { roomId: string; direction: "send" | "recv"; streamType: string },
      callback: (data: any) => void
    ) => {
      const room = rooms[roomId];
      if (!room) return callback({ error: "Room not found" });

      const transport = await createWebRtcTransport(room.router, socket.id, streamType);
      if (direction === "send") {
        room.sendTransports[socket.id].push(transport);
      } else {
        room.recvTransports[socket.id].push(transport);
      }

      callback({
        transportId: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    }
  );

  socket.on(
    "connect-transport",
    async (
      { roomId, transportId, dtlsParameters }: { roomId: string; transportId: string; dtlsParameters: mediasoup.types.DtlsParameters },
      callback: (data: { error?: string }) => void
    ) => {
      const room = rooms[roomId];
      if (!room) return callback({ error: "Room not found" });

      const transport =
        room.sendTransports[socket.id].find((t) => t.id === transportId) ||
        room.recvTransports[socket.id].find((t) => t.id === transportId);
      if (!transport) return callback({ error: "Transport not found" });

      try {
        await transport.connect({ dtlsParameters });
        callback({});
      } catch (err) {
        console.error("❌ Transport connection error:", err);
        callback({ error: (err as Error).message });
      }
    }
  );

  socket.on(
    "produce",
    async (
      { roomId, kind, rtpParameters, streamType }: { roomId: string; kind: mediasoup.types.MediaKind; rtpParameters: mediasoup.types.RtpParameters; streamType: string },
      callback: (data: { id?: string; error?: string }) => void
    ) => {
      const transport = rooms[roomId].sendTransports[socket.id].find((t) => t.appData.streamType === streamType);
      if (!transport) return callback({ error: "Transport not found" });

      const producer = await transport.produce({ kind, rtpParameters, appData: { streamType } });
      rooms[roomId].producers[socket.id].push(producer);
      callback({ id: producer.id });

      rooms[roomId].peers.forEach((peerId) => {
        if (peerId !== socket.id) {
          io.to(peerId).emit("new-stream", { producerId: producer.id, streamType });
        }
      });
    }
  );

  socket.on(
    "consume",
    async (
      { roomId, transportId, rtpCapabilities, producerId }: { roomId: string; transportId: string; rtpCapabilities: mediasoup.types.RtpCapabilities; producerId: string },
      callback: (data: any) => void
    ) => {
      const room = rooms[roomId];
      if (!room) return callback({ error: "Room not found" });

      const transport = room.recvTransports[socket.id].find((t) => t.id === transportId);
      if (!transport) return callback({ error: "Receive transport not found" });

      const consumer = await transport.consume({ producerId, rtpCapabilities, paused: false });
      callback({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    }
  );

  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      rooms[roomId].peers = rooms[roomId].peers.filter((id) => id !== socket.id);
      delete rooms[roomId].sendTransports[socket.id];
      delete rooms[roomId].producers[socket.id];
      delete rooms[roomId].recvTransports[socket.id];
      if (rooms[roomId].peers.length === 0) delete rooms[roomId];
    }
  });

  // Add chat message handling
  socket.on("chat-message", ({ roomId, message, username }: { roomId: string; message: string; username: string }) => {
    // Broadcast the message to all peers in the room
    io.to(roomId).emit("chat-message", {
      message,
      username,
      timestamp: new Date().toISOString(),
    });
  });
});

console.log("server running on port 4000");