import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)))
const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url)))

test("server.json matches package.json", () => {
  assert.equal(server.name, pkg.mcpName)
  assert.equal(server.version, pkg.version)
  assert.equal(server.packages.length, 1)
  assert.equal(server.packages[0].registryType, "npm")
  assert.equal(server.packages[0].identifier, pkg.name)
  assert.equal(server.packages[0].version, pkg.version)
  assert.ok(server.description.length <= 100, "the registry allows 100 characters")
  assert.deepEqual(server.packages[0].environmentVariables.map((v) => [v.name, v.isRequired, v.isSecret]), [["OSINTSX_API_KEY", true, true]])
})

test("the GitHub namespace matches the repository", () => {
  assert.match(server.name, /^io\.github\.osintsx\//)
  assert.equal(server.repository.url, pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""))
})
