#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
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
const initialResult = await auditProductionDependencies(auditLevel);

if (initialResult.failingAdvisories.length === 0) {
    console.log(`Production dependency audit already passed (${initialResult.packageCount} packages checked).`);
    process.exit(0);
}

const vulnerablePackageNames = Array.from(new Set(initialResult.failingAdvisories
    .map(advisoryPackageName)
    .filter((name) => typeof name === "string" && name.length > 0)))
    .sort();

if (vulnerablePackageNames.length === 0) {
    console.error("Audit found advisories, but the registry response did not include package names.");
    printAdvisories(initialResult.failingAdvisories, auditLevel);
    process.exit(1);
}

console.log(`Updating vulnerable production dependency resolutions: ${vulnerablePackageNames.join(", ")}`);
await runCommand("pnpm", [
    "update",
    "--prod",
    "--depth",
    "Infinity",
    ...vulnerablePackageNames
]);

const finalResult = await auditProductionDependencies(auditLevel);
if (finalResult.failingAdvisories.length === 0) {
    console.log(`Production dependency audit passed after targeted update (${finalResult.packageCount} packages checked).`);
    process.exit(0);
}

console.error("Targeted dependency updates did not clear every production advisory.");
console.error("This usually means a patched version is outside an upstream package range or needs an explicit pnpm override.");
printAdvisories(finalResult.failingAdvisories, auditLevel);
process.exit(1);

function runCommand(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: "inherit" });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? "unknown status"}`));
        });
    });
}

async function auditProductionDependencies(level) {
    const tree = await readProductionDependencyTree();
    const packages = collectPackages(tree);

    if (packages.size === 0) {
        return { packageCount: 0, failingAdvisories: [] };
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
    return {
        packageCount: packages.size,
        failingAdvisories: advisories.filter((advisory) => severityRank(advisory.severity) >= severityRank(level))
    };
}

function printAdvisories(advisories, level) {
    console.error(`Production dependency audit found ${advisories.length} advisory/advisories at ${level} or above:`);
    for (const advisory of advisories) {
        const title = advisory.title || advisory.name || "Untitled advisory";
        const vulnerableVersions = advisory.vulnerable_versions || advisory.vulnerableVersions || "unknown versions";
        const patchedVersions = advisory.patched_versions || advisory.patchedVersions || "none listed";
        const url = advisory.url || advisory.more_info || advisory.moreInfo || "";
        console.error(`- [${advisory.severity}] ${advisoryPackageName(advisory) ?? "unknown package"}: ${title}`);
        console.error(`  vulnerable: ${vulnerableVersions}`);
        console.error(`  patched: ${patchedVersions}`);
        if (url) {
            console.error(`  ${url}`);
        }
    }
}

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
    return Object.entries(payload ?? {})
        .flatMap(([packageName, advisories]) => Array.isArray(advisories)
            ? advisories.map((advisory) => ({ module_name: packageName, ...advisory }))
            : [])
        .filter((advisory) => advisory && typeof advisory === "object");
}

function advisoryPackageName(advisory) {
    return advisory.module_name ?? advisory.moduleName ?? advisory.name;
}

function severityRank(severity) {
    return SEVERITY_RANK.get(String(severity ?? "").toLowerCase()) ?? -1;
}
