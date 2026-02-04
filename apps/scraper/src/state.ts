/**
 * State Management for SEBI Scraper
 *
 * Provides persistent state storage for resumable scraping operations.
 */

import { mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import type { ScrapeState, AMC, Scheme, StateConfig } from "./types";
import { createInitialState } from "./types";

/**
 * Loads scrape state from disk
 * Returns initial state if file doesn't exist or is corrupted
 */
export async function loadState(statePath: string): Promise<ScrapeState> {
  try {
    if (!existsSync(statePath)) {
      return createInitialState();
    }

    const content = await Bun.file(statePath).text();
    const state = JSON.parse(content) as ScrapeState;
    return state;
  } catch {
    // Return initial state on any error (corrupted file, etc.)
    return createInitialState();
  }
}

/**
 * Saves scrape state to disk
 * Creates parent directories if needed and updates lastUpdated timestamp
 */
export async function saveState(
  state: ScrapeState,
  statePath: string
): Promise<void> {
  // Create parent directories if needed
  const dir = dirname(statePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  // Update timestamp
  const stateWithTimestamp: ScrapeState = {
    ...state,
    lastUpdated: new Date().toISOString(),
  };

  await Bun.write(statePath, JSON.stringify(stateWithTimestamp, null, 2));
}

/**
 * Deletes the state file
 */
export async function resetState(statePath: string): Promise<void> {
  try {
    if (existsSync(statePath)) {
      await unlink(statePath);
    }
  } catch {
    // Ignore errors (file might not exist)
  }
}

/**
 * State Manager class for managing scrape state
 * Provides methods for tracking progress and auto-saving
 */
export class StateManager {
  private state: ScrapeState;
  private statePath: string;
  private autoSaveInterval: Timer | null = null;
  private dirty = false;

  constructor(
    statePath: string,
    options: { autoSaveIntervalMs?: number } = {}
  ) {
    this.statePath = statePath;
    this.state = createInitialState();

    // Set up auto-save if configured
    if (options.autoSaveIntervalMs && options.autoSaveIntervalMs > 0) {
      this.autoSaveInterval = setInterval(async () => {
        if (this.dirty) {
          await this.save();
          this.dirty = false;
        }
      }, options.autoSaveIntervalMs);
    }
  }

  /**
   * Initialize state from disk
   */
  async initialize(): Promise<void> {
    this.state = await loadState(this.statePath);
  }

  /**
   * Get current state
   */
  getState(): ScrapeState {
    return this.state;
  }

  /**
   * Save current state to disk
   */
  async save(): Promise<void> {
    await saveState(this.state, this.statePath);
    this.dirty = false;
  }

  /**
   * Reset state to initial
   */
  async reset(): Promise<void> {
    await resetState(this.statePath);
    this.state = createInitialState();
    this.dirty = false;
  }

  /**
   * Stop auto-save timer
   */
  stopAutoSave(): void {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
    }
  }

  /**
   * Set current phase
   */
  setPhase(phase: ScrapeState["phase"]): void {
    this.state.phase = phase;
    this.dirty = true;
  }

  /**
   * Add an AMC to state
   */
  addAmc(amc: AMC): void {
    // Check if already exists
    if (!this.state.amcs.find((a) => a.sebiId === amc.sebiId)) {
      this.state.amcs.push(amc);
      this.state.stats.totalAmcs = this.state.amcs.length;
      this.dirty = true;
    }
  }

  /**
   * Add multiple AMCs
   */
  addAmcs(amcs: AMC[]): void {
    for (const amc of amcs) {
      this.addAmc(amc);
    }
  }

  /**
   * Mark an AMC as complete (all its schemes scraped)
   */
  markAmcComplete(sebiId: string): void {
    if (!this.state.completedAmcIds.includes(sebiId)) {
      this.state.completedAmcIds.push(sebiId);
      this.dirty = true;
    }
  }

  /**
   * Add a scheme to state
   */
  addScheme(scheme: Scheme): void {
    // Check if already exists
    if (!this.state.schemes.find((s) => s.sebiSchemeId === scheme.sebiSchemeId)) {
      this.state.schemes.push(scheme);
      this.state.stats.totalSchemes = this.state.schemes.length;
      this.dirty = true;
    }
  }

  /**
   * Add multiple schemes
   */
  addSchemes(schemes: Scheme[]): void {
    for (const scheme of schemes) {
      this.addScheme(scheme);
    }
  }

  /**
   * Update a scheme's PDF URL
   */
  updateSchemePdfUrl(sebiSchemeId: string, pdfUrl: string | null): void {
    const scheme = this.state.schemes.find(
      (s) => s.sebiSchemeId === sebiSchemeId
    );
    if (scheme) {
      scheme.pdfUrl = pdfUrl ?? undefined;
      if (!pdfUrl) {
        this.state.stats.noPdfUrl++;
      }
      this.dirty = true;
    }
  }

  /**
   * Mark a scheme as downloaded
   */
  markSchemeComplete(sebiSchemeId: string): void {
    if (!this.state.completedSchemeIds.includes(sebiSchemeId)) {
      this.state.completedSchemeIds.push(sebiSchemeId);
      this.state.stats.downloadedPdfs++;
      this.dirty = true;
    }
  }

  /**
   * Mark a scheme as failed
   */
  markSchemeFailed(sebiSchemeId: string): void {
    if (!this.state.failedSchemeIds.includes(sebiSchemeId)) {
      this.state.failedSchemeIds.push(sebiSchemeId);
      this.state.stats.failedDownloads++;
      this.dirty = true;
    }
  }

  /**
   * Get AMCs that haven't been scraped for schemes yet
   */
  getPendingAmcs(): AMC[] {
    return this.state.amcs.filter(
      (amc) => !this.state.completedAmcIds.includes(amc.sebiId)
    );
  }

  /**
   * Get schemes that haven't been downloaded yet
   */
  getPendingSchemes(): Scheme[] {
    return this.state.schemes.filter(
      (scheme) =>
        !this.state.completedSchemeIds.includes(scheme.sebiSchemeId) &&
        !this.state.failedSchemeIds.includes(scheme.sebiSchemeId)
    );
  }

  /**
   * Get schemes with PDF URLs that haven't been downloaded
   */
  getDownloadableSchemes(): Scheme[] {
    return this.getPendingSchemes().filter((scheme) => scheme.pdfUrl);
  }
}
