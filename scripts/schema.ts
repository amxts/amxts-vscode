// Writes schemas/menu.schema.json from src/core/shape.ts; test/schema.test.ts
// fails when the file is behind.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { menuSchema } from "../src/core/schema";

const file = join(import.meta.dir, "../schemas/menu.schema.json");
writeFileSync(file, `${JSON.stringify(menuSchema(), null, "\t")}\n`);
console.log(`wrote ${file}`);
