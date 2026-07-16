function isDryRun() {
  return process.env.DRY_RUN === "true";
}

module.exports = { isDryRun };
