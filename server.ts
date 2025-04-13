import { Server, Socket } from "socket.io";
import * as mediasoup from "mediasoup";

const io = new Server(4000, {
  path: "/socket.io",
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

interface Room {
  router: mediasoup.types.Router;
  peers: string[];
  producers: { [socketId: string]: mediasoup.types.Producer[] };
  sendTransports: { [socketId: string]: mediasoup.types.WebRtcTransport[] };
  recvTransports: { [socketId: string]: mediasoup.types.WebRtcTransport[] };
}

let rooms: { [roomId: string]: Room } = {};
let worker: mediasoup.types.Worker;

const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2100,
  });
  console.log(`Worker 생성, PID: ${worker.pid}`);

  worker.on("died", (error) => {
    console.error("Mediasoup worker 사망:", error);
    setTimeout(() => process.exit(1), 2000);
  });

  return worker;
};

const initWorker = async () => {
  worker = await createWorker();
  return worker;
};

initWorker();

const createWebRtcTransport = (
  router: mediasoup.types.Router,
  socketId: string,
  streamType: string
): Promise<mediasoup.types.WebRtcTransport> => {
  return new Promise(async (resolve, reject) => {
    try {
      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: "127.0.0.1", announcedIp: undefined }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        appData: { socketId, streamType },
      });
      resolve(transport);
    } catch (err) {
      reject(err);
    }
  });
};

io.on("connection", (socket: Socket) => {
  console.log("클라이언트 연결:", socket.id, "쿼리:", socket.handshake.query);

  socket.on("reconnect", (attempt) => {
    console.log(`클라이언트 재연결: ${socket.id}, 시도 횟수: ${attempt}`);
    for (const roomId in rooms) {
      rooms[roomId].sendTransports[socket.id]?.forEach((t) => t.close());
      rooms[roomId].recvTransports[socket.id]?.forEach((t) => t.close());
      delete rooms[roomId].sendTransports[socket.id];
      delete rooms[roomId].recvTransports[socket.id];
      rooms[roomId].sendTransports[socket.id] = [];
      rooms[roomId].recvTransports[socket.id] = [];
    }
  });

  socket.on("join-room", async ({ roomId }: { roomId: string }) => {
    if (!rooms[roomId]) {
      const router = await worker.createRouter({
        mediaCodecs: [
          {
            kind: "audio",
            mimeType: "audio/opus",
            clockRate: 48000,
            channels: 2,
          },
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
      console.log(`새 방 생성: ${roomId}`);
    }

    rooms[roomId].peers.push(socket.id);
    rooms[roomId].producers[socket.id] = [];
    rooms[roomId].sendTransports[socket.id] = [];
    rooms[roomId].recvTransports[socket.id] = [];
    socket.join(roomId);
    console.log(`클라이언트 ${socket.id} 방 ${roomId} 입장`);

    const existingProducers: { producerId: string; streamType: string; peerId: string }[] = [];
    Object.keys(rooms[roomId].producers).forEach((peerId) => {
      if (peerId !== socket.id) {
        rooms[roomId].producers[peerId].forEach((producer) => {
          existingProducers.push({
            producerId: producer.id,
            streamType: producer.appData.streamType as string,
            peerId,
          });
        });
      }
    });

    socket.emit("joined-room", { roomId, existingProducers });
  });

  socket.on(
    "get-rtp-capabilities",
    (
      { roomId }: { roomId: string },
      callback: (rtpCapabilities?: mediasoup.types.RtpCapabilities) => void
    ) => {
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
      {
        roomId,
        direction,
        streamType,
      }: { roomId: string; direction: "send" | "recv"; streamType: string },
      callback: (data: any) => void
    ) => {
      const room = rooms[roomId];
      if (!room) {
        console.error(`방 ${roomId} 없음`);
        return callback({ error: "Room not found" });
      }

      const transport = await createWebRtcTransport(room.router, socket.id, streamType);
      if (direction === "send") {
        room.sendTransports[socket.id].push(transport);
        console.log(`Send transport 생성: ${socket.id}, ID: ${transport.id}, Type: ${streamType}`);
      } else {
        room.recvTransports[socket.id].push(transport);
        console.log(`Recv transport 생성: ${socket.id}, ID: ${transport.id}, Type: ${streamType}`);
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
      {
        roomId,
        transportId,
        dtlsParameters,
      }: {
        roomId: string;
        transportId: string;
        dtlsParameters: mediasoup.types.DtlsParameters;
      },
      callback: (data: { error?: string }) => void
    ) => {
      const room = rooms[roomId];
      if (!room) return callback({ error: "Room not found" });

      const transport =
        room.sendTransports[socket.id]?.find((t) => t.id === transportId) ||
        room.recvTransports[socket.id]?.find((t) => t.id === transportId);
      if (!transport) return callback({ error: "Transport not found" });

      try {
        await transport.connect({ dtlsParameters });
        callback({});
      } catch (err) {
        console.error("Transport 연결 에러:", err);
        callback({ error: (err as Error).message });
      }
    }
  );

  socket.on(
    "produce",
    async (
      {
        roomId,
        kind,
        rtpParameters,
        streamType,
      }: {
        roomId: string;
        kind: mediasoup.types.MediaKind;
        rtpParameters: mediasoup.types.RtpParameters;
        streamType: string;
      },
      callback: (data: { id?: string; error?: string }) => void
    ) => {
      const room = rooms[roomId];
      if (!room) {
        console.error(`Produce 실패: 방 ${roomId} 없음`);
        return callback({ error: "Room not found" });
      }

      const transport = room.sendTransports[socket.id]?.find(
        (t) => t.appData.streamType === streamType
      );
      if (!transport) {
        console.error(`Produce 실패: 트랜스포트 없음, 소켓: ${socket.id}, 스트림 타입: ${streamType}`);
        return callback({ error: "Transport not found" });
      }

      // producers[socket.id]가 없으면 초기화
      if (!room.producers[socket.id]) {
        room.producers[socket.id] = [];
      }

      try {
        const producer = await transport.produce({
          kind,
          rtpParameters,
          appData: { streamType },
        });
        room.producers[socket.id].push(producer);
        console.log(`프로듀서 생성: ${producer.id}, 소켓: ${socket.id}, 타입: ${streamType}`);
        callback({ id: producer.id });

        room.peers.forEach((peerId) => {
          if (peerId !== socket.id) {
            io.to(peerId).emit("new-stream", {
              producerId: producer.id,
              streamType,
              peerId: socket.id,
            });
          }
        });
      } catch (err) {
        console.error("프로듀서 생성 에러:", err);
        callback({ error: (err as Error).message });
      }
    }
  );

  socket.on(
    "consume",
    async (
      {
        roomId,
        transportId,
        rtpCapabilities,
        producerId,
      }: {
        roomId: string;
        transportId: string;
        rtpCapabilities: mediasoup.types.RtpCapabilities;
        producerId: string;
      },
      callback: (data: any) => void
    ) => {
      const room = rooms[roomId];
      if (!room) {
        console.error(`Consume 실패: 방 ${roomId} 없음`);
        return callback({ error: "Room not found" });
      }

      console.log(`트랜스포트 검색: ${transportId}, 소켓: ${socket.id}, 방: ${roomId}`);
      const transport = room.recvTransports[socket.id]?.find((t) => t.id === transportId);
      if (!transport) {
        console.error(
          `Consume 실패: 트랜스포트 ${transportId} 없음, 소켓: ${socket.id}`,
          room.recvTransports[socket.id]?.map((t) => t.id) || "트랜스포트 없음"
        );
        socket.emit("retry-transport", { roomId });
        return callback({ error: "Receive transport not found" });
      }

      try {
        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: false,
        });
        console.log(`컨슈머 생성: ${consumer.id}, 프로듀서: ${producerId}, 소켓: ${socket.id}`);

        callback({
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      } catch (err) {
        console.error("컨슈머 생성 에러:", err);
        callback({ error: (err as Error).message });
      }
    }
  );

  socket.on(
    "retry-transport",
    ({ roomId }: { roomId: string }) => {
      console.log(`트랜스포트 재시도 요청: 소켓 ${socket.id}, 방 ${roomId}`);
      rooms[roomId].recvTransports[socket.id]?.forEach((t) => t.close());
      rooms[roomId].recvTransports[socket.id] = [];
      socket.emit("reset-transport", { roomId });
    }
  );

  socket.on("disconnect", () => {
    console.log("클라이언트 연결 해제:", socket.id);
    for (const roomId in rooms) {
      rooms[roomId].peers = rooms[roomId].peers.filter((id) => id !== socket.id);
      rooms[roomId].producers[socket.id]?.forEach((producer) => producer.close());
      rooms[roomId].sendTransports[socket.id]?.forEach((transport) =>
        transport.close()
      );
      rooms[roomId].recvTransports[socket.id]?.forEach((transport) =>
        transport.close()
      );
      delete rooms[roomId].producers[socket.id];
      delete rooms[roomId].sendTransports[socket.id];
      delete rooms[roomId].recvTransports[socket.id];
      if (rooms[roomId].peers.length === 0) {
        delete rooms[roomId];
        console.log(`방 ${roomId} 삭제: 참가자 없음`);
      } else {
        io.to(roomId).emit("user-disconnected", socket.id);
      }
    }
  });

  socket.on(
    "chat-message",
    ({
      roomId,
      message,
      username,
    }: {
      roomId: string;
      message: string;
      username: string;
    }) => {
      console.log("채팅 메시지 수신:", { roomId, text: message, sender: username });
      io.to(roomId).emit("chat-message", {
        text: message,
        sender: username,
        timestamp: new Date().toISOString(),
      });
    }
  );

  socket.on(
    "startDraw",
    ({ roomId, x, y }: { roomId: string; x: number; y: number }) => {
      socket.to(roomId).emit("startDraw", { x, y });
    }
  );

  socket.on(
    "draw",
    ({
      roomId,
      x,
      y,
      color,
      lineWidth,
    }: {
      roomId: string;
      x: number;
      y: number;
      color: string;
      lineWidth: number;
    }) => {
      socket.to(roomId).emit("draw", { x, y, color, lineWidth });
    }
  );

  socket.on("clearCanvas", ({ roomId }: { roomId: string }) => {
    socket.to(roomId).emit("clearCanvas");
  });

  socket.on("addImage", ({ roomId, imageSrc }: { roomId: string; imageSrc: string }) => {
    socket.to(roomId).emit("addImage", imageSrc);
  });
});

console.log("서버 실행 중: 포트 4000");