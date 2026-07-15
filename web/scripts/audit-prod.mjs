#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BULK_AUDIT_URL = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
const AUDIT_TIMEOUT_MS = 20_000;
const SEVERITY_RANK = new Map([
    ["info", 0],
    ["low", 1],
    ["moderate", 2],
    ["high", 3],
    ["critical", 4]
]);

const auditLevel = parseAuditLevel(process.argv);

const tree = await readProductionDependencyTree();
const packages = collectPackages(tree);

if (packages.size === 0) {
    console.log("No production dependencies found to audit.");
    process.exit(0);
}

const response = await fetchWithTimeout(BULK_AUDIT_URL, {
    method: "POST",
    headers: {
        "accept": "application/json",
        "content-type": "application/json"
    },
    body: JSON.stringify(Object.fromEntries(
        Array.from(packages.entries())
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, versions]) => [name, Array.from(versions).sort()])
    ))
});

if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Audit endpoint responded with ${response.status}${body ? `: ${body}` : ""}`);
}

const advisories = flattenAdvisories(await response.json());
const failingAdvisories = advisories.filter((advisory) => severityRank(advisory.severity) >= severityRank(auditLevel));

if (failingAdvisories.length === 0) {
    console.log(`Production dependency audit passed (${packages.size} packages checked).`);
    process.exit(0);
}

console.error(`Production dependency audit found ${failingAdvisories.length} advisory/advisories at ${auditLevel} or above:`);
for (const advisory of failingAdvisories) {
    const title = advisory.title || advisory.name || "Untitled advisory";
    const vulnerableVersions = advisory.vulnerable_versions || advisory.vulnerableVersions || "unknown versions";
    const patchedVersions = advisory.patched_versions || advisory.patchedVersions || "none listed";
    const url = advisory.url || advisory.more_info || advisory.moreInfo || "";
    console.error(`- [${advisory.severity}] ${advisory.module_name ?? advisory.name}: ${title}`);
    console.error(`  vulnerable: ${vulnerableVersions}`);
    console.error(`  patched: ${patchedVersions}`);
    if (url) {
        console.error(`  ${url}`);
    }
}
process.exit(1);

function parseAuditLevel(argv) {
    const explicitLevel = argv.find((arg) => arg.startsWith("--audit-level="))?.split("=")[1] ?? "low";
    if (!SEVERITY_RANK.has(explicitLevel)) {
        throw new Error(`Unsupported audit level "${explicitLevel}". Use one of: ${Array.from(SEVERITY_RANK.keys()).join(", ")}`);
    }
    return explicitLevel;
}

async function readProductionDependencyTree() {
    const { stdout } = await execFileAsync("pnpm", ["list", "--prod", "--depth", "Infinity", "--json"], {
        maxBuffer: 32 * 1024 * 1024
    });
    return JSON.parse(stdout);
}

function collectPackages(tree) {
    const packages = new Map();
    const stack = Array.isArray(tree) ? [...tree] : [tree];
    const seenNodes = new Set();

    while (stack.length > 0) {
        const node = stack.pop();
        if (!node || typeof node !== "object") {
            continue;
        }

        const nodeKey = typeof node.path === "string"
            ? node.path
            : `${node.name ?? ""}@${node.version ?? ""}`;
        if (nodeKey && seenNodes.has(nodeKey)) {
            continue;
        }
        if (nodeKey) {
            seenNodes.add(nodeKey);
        }

        if (typeof node.name === "string" && typeof node.version === "string" && node.name !== "goldshelf-web") {
            const versions = packages.get(node.name) ?? new Set();
            versions.add(node.version);
            packages.set(node.name, versions);
        }

        for (const [dependencyName, dependency] of Object.entries(node.dependencies ?? {})) {
            stack.push({
                name: dependency.name ?? dependencyName,
                ...dependency
            });
        }
    }

    return packages;
}

async function fetchWithTimeout(url, init) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AUDIT_TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

function flattenAdvisories(payload) {
    return Object.values(payload ?? {})
        .flat()
        .filter((advisory) => advisory && typeof advisory === "object");
}

function severityRank(severity) {
    return SEVERITY_RANK.get(String(severity ?? "").toLowerCase()) ?? -1;
}
