import { test, expect } from "@playwright/test";
import { parseSalesId } from "@/lib/purchase/sales-id";

test("extracts digits from Product_Sales_ID_<digits>", () => {
  expect(parseSalesId("Product_Sales_ID_2880 (3).xlsx")).toBe("2880");
  expect(parseSalesId("product_sales_id_2922-final.xlsx")).toBe("2922");
});

test("returns null when absent or digits missing", () => {
  expect(parseSalesId("report.xlsx")).toBeNull();
  expect(parseSalesId("Product_Sales_ID_.xlsx")).toBeNull();
});
