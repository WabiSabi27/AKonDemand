import { Router, type IRouter } from "express";
import { eq, inArray } from "drizzle-orm";
import { db, businessesTable, businessEmployeesTable } from "@workspace/db";
import {
  ListBusinessesQueryParams,
  ListBusinessesResponse,
  GetBusinessParams,
  GetBusinessResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/businesses", async (req, res) => {
  const q = ListBusinessesQueryParams.parse(req.query);
  const rows = q.categoryId
    ? await db.select().from(businessesTable).where(eq(businessesTable.categoryId, q.categoryId))
    : await db.select().from(businessesTable);

  // Eager-load employees so the customer's capacity calculation (filters by
  // `requiredSpecialty`) and the SP's account screen don't need extra round-trips.
  const ids = rows.map((b) => b.id);
  const allEmployees = ids.length
    ? await db.select().from(businessEmployeesTable).where(inArray(businessEmployeesTable.businessId, ids))
    : [];
  const employeesByBusiness = new Map<string, typeof allEmployees>();
  for (const emp of allEmployees) {
    const bucket = employeesByBusiness.get(emp.businessId);
    if (bucket) bucket.push(emp);
    else employeesByBusiness.set(emp.businessId, [emp]);
  }
  const result = rows.map((b) => ({ ...b, employees: employeesByBusiness.get(b.id) ?? [] }));

  req.log.info({ count: rows.length, categoryId: q.categoryId }, "listBusinesses");
  res.json(ListBusinessesResponse.parse(result));
});

router.get("/businesses/:id", async (req, res) => {
  const { id } = GetBusinessParams.parse(req.params);
  const [biz] = await db.select().from(businessesTable).where(eq(businessesTable.id, id));
  if (!biz) {
    req.log.warn({ id }, "business not found");
    res.status(404).json({ error: "Business not found" });
    return;
  }
  const employees = await db
    .select()
    .from(businessEmployeesTable)
    .where(eq(businessEmployeesTable.businessId, id));

  res.json(GetBusinessResponse.parse({ ...biz, employees }));
});

export default router;
