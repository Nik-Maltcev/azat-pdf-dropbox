import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Serve frontend static files in production
if (process.env.NODE_ENV === "production") {
  const staticPath = path.resolve(process.cwd(), "artifacts/pdf-renamer/dist/public");
  app.use(express.static(staticPath));
  app.get("{*path}", (_req, res) => {
    res.sendFile(path.join(staticPath, "index.html"));
  });
}

export default app;
