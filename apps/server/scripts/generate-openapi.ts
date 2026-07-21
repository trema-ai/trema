import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { generateOpenApiDocument } from "../src/openapi.js";

// Write the OpenAPI document to `openapi.json` at the package root. The docs
// site reads this file to render the API reference.
const outputPath = fileURLToPath(new URL("../openapi.json", import.meta.url));

const document = await generateOpenApiDocument();
await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`);

console.info(`Wrote OpenAPI spec to ${outputPath}`);
