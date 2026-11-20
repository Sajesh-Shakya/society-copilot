// Extracts the eActivities product sales id from an export filename such as
// "Product_Sales_ID_2880 (3).xlsx". Returns null when the pattern is absent.
export function parseSalesId(filename: string): string | null {
  const match = /Product_Sales_ID_(\d+)/i.exec(filename);
  return match ? match[1] : null;
}
