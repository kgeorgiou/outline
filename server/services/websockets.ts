import http, { IncomingMessage } from "http";
import { Duplex } from "stream";
import invariant from "invariant";
import Koa from "koa";
import IO from "socket.io";
import { createAdapter } from "socket.io-redis";
import Logger from "@server/logging/Logger";
import Metrics from "@server/logging/metrics";
import * as Tracing from "@server/logging/tracing";
import { APM } from "@server/logging/tracing";
import { Collection, User } from "@server/models";
import { can } from "@server/policies";
import { getUserForJWT } from "@server/utils/jwt";
import { websocketQueue } from "../queues";
import WebsocketsProcessor from "../queues/processors/WebsocketsProcessor";
import Redis from "../redis";

type SocketWithAuth = IO.Socket & {
  client: IO.Socket["client"] & {
    user?: User;
  };
};

export default function init(
  app: Koa,
  server: http.Server,
  serviceNames: string[]
) {
  const path = "/realtime";

  // Websockets for events and non-collaborative documents
  const io = new IO.Server(server, {
    path,
    allowEIO3: true,
    serveClient: false,
    cookie: false,
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  // Remove the upgrade handler that we just added when registering the IO engine
  // And re-add it with a check to only handle the realtime path, this allows
  // collaboration websockets to exist in the same process as engine.io.
  const listeners = server.listeners("upgrade");
  const ioHandleUpgrade = listeners.pop();

  if (ioHandleUpgrade) {
    server.removeListener(
      "upgrade",
      ioHandleUpgrade as (...args: any[]) => void
    );
  }

  server.on("upgrade", function (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ) {
    if (req.url?.startsWith(path)) {
      invariant(ioHandleUpgrade, "Existing upgrade handler must exist");
      ioHandleUpgrade(req, socket, head);
      return;
    }

    if (serviceNames.includes("collaboration")) {
      // Nothing to do, the collaboration service will handle this request
      return;
    }

    // If the collaboration service isn't running then we need to close the connection
    socket.end(`HTTP/1.1 400 Bad Request\r\n`);
  });

  server.on("shutdown", () => {
    Metrics.gaugePerInstance("websockets.count", 0);
  });

  io.adapter(
    createAdapter({
      pubClient: Redis.defaultClient,
      subClient: Redis.defaultSubscriber,
    })
  );

  io.of("/").adapter.on("error", (err: Error) => {
    if (err.name === "MaxRetriesPerRequestError") {
      Logger.error("Redis maximum retries exceeded in socketio adapter", err);
      throw err;
    } else {
      Logger.error("Redis error in socketio adapter", err);
    }
  });

  io.on("connection", (socket: SocketWithAuth) => {
    Metrics.increment("websockets.connected");
    Metrics.gaugePerInstance(
      "websockets.count",
      socket.client.conn.server.clientsCount
    );

    socket.on("authentication", async function (data) {
      try {
        await authenticate(socket, data);
        Logger.debug("websockets", `Authenticated socket ${socket.id}`);

        socket.emit("authenticated", true);
        void authenticated(io, socket);
      } catch (err) {
        Logger.error(`Authentication error socket ${socket.id}`, err);
        socket.emit("unauthorized", { message: err.message }, function () {
          socket.disconnect();
        });
      }
    });

    socket.on("disconnect", async () => {
      Metrics.increment("websockets.disconnected");
      Metrics.gaugePerInstance(
        "websockets.count",
        socket.client.conn.server.clientsCount
      );
      await Redis.defaultClient.hdel(socket.id, "userId");
    });

    setTimeout(function () {
      // If the socket didn't authenticate after connection, disconnect it
      if (!socket.client.user) {
        Logger.debug("websockets", `Disconnecting socket ${socket.id}`);

        // @ts-expect-error should be boolean
        socket.disconnect("unauthorized");
      }
    }, 1000);
  });

  // Handle events from event queue that should be sent to the clients down ws
  const websockets = new WebsocketsProcessor();
  websocketQueue.process(
    APM.traceFunction({
      serviceName: "websockets",
      spanName: "process",
      isRoot: true,
    })(async function (job) {
      const event = job.data;

      Tracing.setResource(`Processor.WebsocketsProcessor`);

      websockets.perform(event, io).catch((error) => {
        Logger.error("Error processing websocket event", error, {
          event,
        });
      });
    })
  );
}

async function authenticated(io: IO.Server, socket: SocketWithAuth) {
  const { user } = socket.client;
  if (!user) {
    throw new Error("User not returned from auth");
  }

  // the rooms associated with the current team
  // and user so we can send authenticated events
  const rooms = [`team-${user.teamId}`, `user-${user.id}`];

  // the rooms associated with collections this user
  // has access to on connection. New collection subscriptions
  // are managed from the client as needed through the 'join' event
  const collectionIds: string[] = await user.collectionIds();

  collectionIds.forEach((collectionId) =>
    rooms.push(`collection-${collectionId}`)
  );

  // join all of the rooms at once
  socket.join(rooms);

  // allow the client to request to join rooms
  socket.on("join", async (event) => {
    // user is joining a collection channel, because their permissions have
    // changed, granting them access.
    if (event.collectionId) {
      const collection = await Collection.scope({
        method: ["withMembership", user.id],
      }).findByPk(event.collectionId);

      if (can(user, "read", collection)) {
        await socket.join(`collection-${event.collectionId}`);
        Metrics.increment("websockets.collections.join");
      }
    }
  });

  // allow the client to request to leave rooms
  socket.on("leave", async (event) => {
    if (event.collectionId) {
      await socket.leave(`collection-${event.collectionId}`);
      Metrics.increment("websockets.collections.leave");
    }
  });
}

/**
 * Authenticate the socket with the given token, attach the user model for the
 * duration of the session.
 */
async function authenticate(socket: SocketWithAuth, data: { token: string }) {
  const { token } = data;

  const user = await getUserForJWT(token);
  socket.client.user = user;

  // store the mapping between socket id and user id in redis so that it is
  // accessible across multiple websocket servers. Lasts 24 hours, if they have
  // a websocket connection that lasts this long then well done.
  await Redis.defaultClient.hset(socket.id, "userId", user.id);
  await Redis.defaultClient.expire(socket.id, 3600 * 24);
}
