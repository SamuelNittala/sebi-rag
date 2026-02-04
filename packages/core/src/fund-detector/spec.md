# Feature: Fund-Aware Query Handling (Phase 2.2)

## Problem Statement

Users often mention fund names in their queries (e.g., "What is the expense ratio of HDFC Focused Fund?"). Currently, they must manually specify `--fund` filter. The system should automatically detect fund mentions and apply filters.

## Requirements

### Functional Requirements

- [ ] FR-1: Detect fund names mentioned in user queries
- [ ] FR-2: Match detected names against known funds (exact and fuzzy)
- [ ] FR-3: Auto-apply fund filter when a single fund is detected
- [ ] FR-4: Return multiple matches when query is ambiguous
- [ ] FR-5: Handle common variations (abbreviations, partial names)
- [ ] FR-6: Support AMC-level filtering ("HDFC funds", "SBI schemes")

### Non-Functional Requirements

- [ ] NFR-1: Detection should add < 50ms to query time
- [ ] NFR-2: False positive rate < 5% (don't filter when not intended)
- [ ] NFR-3: Index should be refreshable without restart

## Fund Name Patterns

From indexed data:
```
360 ONE Dynamic Bond Fund
Axis Value Fund
HDFC Focused 30 Fund
SBI Bluechip Fund
quant Quantamental Fund
Deutsche Mutual Fund - Equity
```

Common patterns:
- `{AMC} {Type} Fund` - "Axis Value Fund"
- `{AMC} {Category} {Type} Fund` - "HDFC Focused 30 Fund"
- `{AMC} {Product}` - "Deutsche Mutual Fund - Equity"
- Abbreviations: "SBI", "HDFC", "DSP", "BOI"

## Detection Strategy

### Phase 1: Exact substring match
```
Query: "What is HDFC Focused 30 Fund expense ratio?"
Match: "HDFC Focused 30 Fund" (exact)
```

### Phase 2: Normalized match
```
Query: "Tell me about hdfc focused fund"
Normalize: "hdfc focused fund" → matches "HDFC Focused 30 Fund"
```

### Phase 3: AMC prefix match
```
Query: "Compare HDFC equity funds"
Match: All funds starting with "HDFC" + scheme_type = "Equity"
```

### Phase 4: Fuzzy match (optional)
```
Query: "Axis Value"
Match: "Axis Value Fund" (partial match, high confidence)
```

## Interface Design

```typescript
interface FundMatch {
  fundName: string;
  confidence: number;  // 0-1
  matchType: "exact" | "normalized" | "partial" | "amc";
}

interface DetectionResult {
  matches: FundMatch[];
  amcFilter?: string;      // If AMC-level match detected
  suggestedFilter?: QueryFilters;
  ambiguous: boolean;      // True if multiple high-confidence matches
}

interface IFundDetector {
  /** Load/refresh fund index from data source */
  loadIndex(): Promise<void>;

  /** Detect fund mentions in query */
  detect(query: string): DetectionResult;

  /** Get all known fund names */
  getFundNames(): string[];
}
```

## Acceptance Criteria

### Single Fund Detection
```
Given query "What is the expense ratio of HDFC Focused 30 Fund?"
When detecting funds
Then:
  - matches contains "HDFC Focused 30 Fund"
  - confidence >= 0.9
  - ambiguous = false
  - suggestedFilter = { fundName: "HDFC Focused 30 Fund" }
```

### Partial Match
```
Given query "Tell me about Axis Value"
When detecting funds
Then:
  - matches contains "Axis Value Fund"
  - confidence >= 0.7
  - ambiguous = false
```

### AMC-Level Detection
```
Given query "Compare all HDFC funds"
When detecting funds
Then:
  - amcFilter = "HDFC"
  - matches contains all HDFC funds
  - ambiguous = false (AMC intent is clear)
```

### Ambiguous Query
```
Given query "Tell me about equity funds"
When detecting funds
Then:
  - matches = [] (no specific fund mentioned)
  - ambiguous = false (generic query, not fund-specific)
```

### No Fund Mentioned
```
Given query "What are mutual fund risk factors?"
When detecting funds
Then:
  - matches = []
  - suggestedFilter = undefined
```

## Edge Cases

1. **Multiple funds in query**: "Compare HDFC Focused and Axis Value funds"
   - Return both matches, let user choose or query both

2. **Fund name is common word**: "What is the value of my investment?"
   - "Value" shouldn't match "Axis Value Fund" (context matters)

3. **Misspelled fund name**: "HDFC Focussed Fund"
   - Fuzzy match with lower confidence

4. **Ambiguous AMC**: "What are SBI fund options?"
   - Return AMC filter, not specific fund

5. **Fund name with numbers**: "HDFC Focused 30"
   - Should match "HDFC Focused 30 Fund"

## Implementation Approach

1. **Build index on startup**:
   - Load unique fund names from Qdrant
   - Create normalized versions (lowercase, no special chars)
   - Extract AMC prefixes

2. **Detection algorithm**:
   ```
   1. Normalize query (lowercase)
   2. Check for exact fund name matches
   3. Check for partial matches (fund name contained in query)
   4. Check for AMC mentions
   5. Score and rank matches by confidence
   6. Return top matches or ambiguous flag
   ```

3. **Integration with RAGPipeline**:
   - Add optional `autoDetectFund` flag (default: true)
   - Before query, run detection
   - If single high-confidence match, apply filter
   - If ambiguous, return suggestions to user

## File Structure

```
packages/core/src/fund-detector/
├── spec.md           # This file
├── types.ts          # FundMatch, DetectionResult interfaces
├── index.ts          # FundDetector class
└── index.test.ts     # Tests
```

## Out of Scope

- Learning from user corrections
- Synonym handling ("Bluechip" = "Large Cap")
- Cross-language fund name matching
- Fund name extraction from uploaded documents
