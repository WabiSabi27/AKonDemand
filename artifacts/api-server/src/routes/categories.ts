import { Router, type IRouter } from "express";
import { db, categoriesTable } from "@workspace/db";
import { ListCategoriesResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/categories", async (req, res) => {
  const rows = await db.select().from(categoriesTable);
  req.log.info({ count: rows.length }, "listCategories");
  res.json(ListCategoriesResponse.parse(rows));
});

export default router;
