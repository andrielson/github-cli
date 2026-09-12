#!/usr/bin/env node
"use strict";

try {
  require("../dist/shim.js");
} catch (error) {
  if (error && typeof error === "object" && error.code === "MODULE_NOT_FOUND") {
    process.stderr.write(
      "gh: the shim bundle is missing from this installation; in a source checkout run `bun run build` at the repository root\n"
    );
    process.exitCode = 1;
  } else {
    throw error;
  }
}
