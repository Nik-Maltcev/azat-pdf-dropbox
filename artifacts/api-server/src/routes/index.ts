import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dropboxRouter from "./dropbox";

const router: IRouter = Router();

router.use(healthRouter);
router.use(dropboxRouter);

export default router;
