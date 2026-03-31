#!/usr/bin/env node

const cmd = process.argv[2];

if (cmd === "setup" || cmd === "doctor") {
  import("./cli.js").then((cli) => {
    const fn = cmd === "setup" ? cli.setup : cli.doctor;
    fn().catch((err) => {
      process.stderr.write(`Error: ${String(err)}\n`);
      process.exit(1);
    });
  });
} else {
  require("./index.js");
}
