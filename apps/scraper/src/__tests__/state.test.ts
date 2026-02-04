import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { loadState, saveState, resetState, StateManager } from "../state";
import type { ScrapeState, AMC, Scheme } from "../types";
import { rm, mkdir, readFile } from "fs/promises";
import { existsSync } from "fs";

const TEST_STATE_DIR = "/home/samuel/projects/mf-pdf-rag/data/test-state";
const TEST_STATE_PATH = `${TEST_STATE_DIR}/test-state.json`;

describe("State Persistence", () => {
  beforeEach(async () => {
    if (existsSync(TEST_STATE_DIR)) {
      await rm(TEST_STATE_DIR, { recursive: true });
    }
    await mkdir(TEST_STATE_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(TEST_STATE_DIR)) {
      await rm(TEST_STATE_DIR, { recursive: true });
    }
  });

  describe("loadState", () => {
    test("returns initial state when file doesn't exist", async () => {
      const state = await loadState(TEST_STATE_PATH);

      expect(state.phase).toBe("idle");
      expect(state.amcs).toEqual([]);
      expect(state.schemes).toEqual([]);
      expect(state.completedAmcIds).toEqual([]);
      expect(state.completedSchemeIds).toEqual([]);
      expect(state.failedSchemeIds).toEqual([]);
      expect(state.stats.totalAmcs).toBe(0);
    });

    test("loads existing state from file", async () => {
      const existingState: ScrapeState = {
        phase: "scraping_schemes",
        amcs: [{ sebiId: "MF001", name: "Test AMC" }],
        schemes: [],
        completedAmcIds: ["MF001"],
        completedSchemeIds: [],
        failedSchemeIds: [],
        lastUpdated: "2026-01-15T10:00:00Z",
        stats: {
          totalAmcs: 1,
          totalSchemes: 0,
          downloadedPdfs: 0,
          failedDownloads: 0,
          noPdfUrl: 0,
        },
      };

      await Bun.write(TEST_STATE_PATH, JSON.stringify(existingState, null, 2));

      const state = await loadState(TEST_STATE_PATH);

      expect(state.phase).toBe("scraping_schemes");
      expect(state.amcs).toHaveLength(1);
      expect(state.amcs[0].sebiId).toBe("MF001");
      expect(state.completedAmcIds).toEqual(["MF001"]);
    });

    test("handles corrupted state file gracefully", async () => {
      await Bun.write(TEST_STATE_PATH, "{ invalid json");

      const state = await loadState(TEST_STATE_PATH);

      // Should return initial state, not throw
      expect(state.phase).toBe("idle");
      expect(state.amcs).toEqual([]);
    });
  });

  describe("saveState", () => {
    test("saves state to file", async () => {
      const state: ScrapeState = {
        phase: "downloading",
        amcs: [
          { sebiId: "MF001", name: "Test AMC 1" },
          { sebiId: "MF002", name: "Test AMC 2" },
        ],
        schemes: [
          {
            sebiSchemeId: "SCH001",
            sebiFundId: "MF001",
            name: "Test Scheme",
            amcName: "Test AMC 1",
          },
        ],
        completedAmcIds: ["MF001", "MF002"],
        completedSchemeIds: [],
        failedSchemeIds: [],
        lastUpdated: new Date().toISOString(),
        stats: {
          totalAmcs: 2,
          totalSchemes: 1,
          downloadedPdfs: 0,
          failedDownloads: 0,
          noPdfUrl: 0,
        },
      };

      await saveState(state, TEST_STATE_PATH);

      expect(existsSync(TEST_STATE_PATH)).toBe(true);

      const content = await readFile(TEST_STATE_PATH, "utf-8");
      const loaded = JSON.parse(content);
      expect(loaded.phase).toBe("downloading");
      expect(loaded.amcs).toHaveLength(2);
    });

    test("creates parent directories if needed", async () => {
      const nestedPath = `${TEST_STATE_DIR}/nested/dirs/state.json`;

      const state: ScrapeState = {
        phase: "idle",
        amcs: [],
        schemes: [],
        completedAmcIds: [],
        completedSchemeIds: [],
        failedSchemeIds: [],
        lastUpdated: new Date().toISOString(),
        stats: {
          totalAmcs: 0,
          totalSchemes: 0,
          downloadedPdfs: 0,
          failedDownloads: 0,
          noPdfUrl: 0,
        },
      };

      await saveState(state, nestedPath);

      expect(existsSync(nestedPath)).toBe(true);
    });

    test("updates lastUpdated timestamp", async () => {
      const originalDate = "2025-01-01T00:00:00Z";
      const state: ScrapeState = {
        phase: "idle",
        amcs: [],
        schemes: [],
        completedAmcIds: [],
        completedSchemeIds: [],
        failedSchemeIds: [],
        lastUpdated: originalDate,
        stats: {
          totalAmcs: 0,
          totalSchemes: 0,
          downloadedPdfs: 0,
          failedDownloads: 0,
          noPdfUrl: 0,
        },
      };

      await saveState(state, TEST_STATE_PATH);

      const content = await readFile(TEST_STATE_PATH, "utf-8");
      const loaded = JSON.parse(content);
      // lastUpdated should be updated to current time
      expect(loaded.lastUpdated).not.toBe(originalDate);
    });
  });

  describe("resetState", () => {
    test("deletes state file", async () => {
      await Bun.write(TEST_STATE_PATH, JSON.stringify({ phase: "downloading" }));
      expect(existsSync(TEST_STATE_PATH)).toBe(true);

      await resetState(TEST_STATE_PATH);

      expect(existsSync(TEST_STATE_PATH)).toBe(false);
    });

    test("handles non-existent file gracefully", async () => {
      expect(existsSync(TEST_STATE_PATH)).toBe(false);

      // Should not throw
      await resetState(TEST_STATE_PATH);
    });
  });

  describe("StateManager", () => {
    test("initializes with loaded or initial state", async () => {
      const manager = new StateManager(TEST_STATE_PATH);
      await manager.initialize();

      const state = manager.getState();
      expect(state.phase).toBe("idle");
    });

    test("tracks AMC completion", async () => {
      const manager = new StateManager(TEST_STATE_PATH);
      await manager.initialize();

      const amc: AMC = { sebiId: "MF001", name: "Test AMC" };
      manager.addAmc(amc);
      manager.markAmcComplete("MF001");

      const state = manager.getState();
      expect(state.amcs).toHaveLength(1);
      expect(state.completedAmcIds).toContain("MF001");
    });

    test("tracks scheme completion", async () => {
      const manager = new StateManager(TEST_STATE_PATH);
      await manager.initialize();

      const scheme: Scheme = {
        sebiSchemeId: "SCH001",
        sebiFundId: "MF001",
        name: "Test Scheme",
        amcName: "Test AMC",
      };
      manager.addScheme(scheme);
      manager.markSchemeComplete("SCH001");

      const state = manager.getState();
      expect(state.schemes).toHaveLength(1);
      expect(state.completedSchemeIds).toContain("SCH001");
    });

    test("tracks failed schemes", async () => {
      const manager = new StateManager(TEST_STATE_PATH);
      await manager.initialize();

      manager.markSchemeFailed("SCH001");

      const state = manager.getState();
      expect(state.failedSchemeIds).toContain("SCH001");
      expect(state.stats.failedDownloads).toBe(1);
    });

    test("auto-saves state periodically", async () => {
      const manager = new StateManager(TEST_STATE_PATH, { autoSaveIntervalMs: 50 });
      await manager.initialize();

      manager.addAmc({ sebiId: "MF001", name: "Test AMC" });

      // Wait for auto-save
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(existsSync(TEST_STATE_PATH)).toBe(true);

      manager.stopAutoSave();
    });

    test("resumes from incomplete AMC scraping", async () => {
      // Set up initial state with partial AMC scraping
      const existingState: ScrapeState = {
        phase: "scraping_amcs",
        amcs: [
          { sebiId: "MF001", name: "AMC 1" },
          { sebiId: "MF002", name: "AMC 2" },
        ],
        schemes: [],
        completedAmcIds: ["MF001"], // Only first AMC is complete
        completedSchemeIds: [],
        failedSchemeIds: [],
        lastUpdated: new Date().toISOString(),
        stats: {
          totalAmcs: 2,
          totalSchemes: 0,
          downloadedPdfs: 0,
          failedDownloads: 0,
          noPdfUrl: 0,
        },
      };
      await Bun.write(TEST_STATE_PATH, JSON.stringify(existingState, null, 2));

      const manager = new StateManager(TEST_STATE_PATH);
      await manager.initialize();

      const pendingAmcs = manager.getPendingAmcs();
      expect(pendingAmcs).toHaveLength(1);
      expect(pendingAmcs[0].sebiId).toBe("MF002");
    });

    test("resumes from incomplete downloads", async () => {
      const existingState: ScrapeState = {
        phase: "downloading",
        amcs: [{ sebiId: "MF001", name: "AMC 1" }],
        schemes: [
          {
            sebiSchemeId: "SCH001",
            sebiFundId: "MF001",
            name: "Scheme 1",
            amcName: "AMC 1",
            pdfUrl: "https://example.com/1.pdf",
          },
          {
            sebiSchemeId: "SCH002",
            sebiFundId: "MF001",
            name: "Scheme 2",
            amcName: "AMC 1",
            pdfUrl: "https://example.com/2.pdf",
          },
          {
            sebiSchemeId: "SCH003",
            sebiFundId: "MF001",
            name: "Scheme 3",
            amcName: "AMC 1",
            pdfUrl: "https://example.com/3.pdf",
          },
        ],
        completedAmcIds: ["MF001"],
        completedSchemeIds: ["SCH001"], // Only first scheme downloaded
        failedSchemeIds: [],
        lastUpdated: new Date().toISOString(),
        stats: {
          totalAmcs: 1,
          totalSchemes: 3,
          downloadedPdfs: 1,
          failedDownloads: 0,
          noPdfUrl: 0,
        },
      };
      await Bun.write(TEST_STATE_PATH, JSON.stringify(existingState, null, 2));

      const manager = new StateManager(TEST_STATE_PATH);
      await manager.initialize();

      const pendingSchemes = manager.getPendingSchemes();
      expect(pendingSchemes).toHaveLength(2);
      expect(pendingSchemes.map((s) => s.sebiSchemeId)).toEqual(["SCH002", "SCH003"]);
    });

    test("updates stats correctly", async () => {
      const manager = new StateManager(TEST_STATE_PATH);
      await manager.initialize();

      manager.addAmc({ sebiId: "MF001", name: "AMC 1" });
      manager.addAmc({ sebiId: "MF002", name: "AMC 2" });
      manager.addScheme({
        sebiSchemeId: "SCH001",
        sebiFundId: "MF001",
        name: "Scheme 1",
        amcName: "AMC 1",
      });
      manager.markSchemeComplete("SCH001");

      const state = manager.getState();
      expect(state.stats.totalAmcs).toBe(2);
      expect(state.stats.totalSchemes).toBe(1);
      expect(state.stats.downloadedPdfs).toBe(1);
    });
  });
});
