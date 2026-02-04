#!/usr/bin/env python3
"""
Table extraction using pdfplumber.
CLI interface: python extract.py <pdf_path> [--page N]
Output: JSON to stdout
"""

import argparse
import json
import sys
from typing import Optional

import pdfplumber


# Table settings optimized for financial documents
# Using "lines" strategy first for tables with visible borders
# Falls back to "text" strategy for borderless tables
TABLE_SETTINGS_LINES = {
    "vertical_strategy": "lines",
    "horizontal_strategy": "lines",
    "snap_tolerance": 3,
    "join_tolerance": 3,
    "edge_min_length": 3,
}

TABLE_SETTINGS_TEXT = {
    "vertical_strategy": "text",
    "horizontal_strategy": "text",
    "snap_tolerance": 5,
    "join_tolerance": 5,
    "min_words_vertical": 3,
    "min_words_horizontal": 1,
}

# Minimum requirements for a valid table
MIN_ROWS = 2  # At least header + one data row
MIN_COLUMNS = 2  # At least 2 columns to be considered a table


def clean_cell(cell: Optional[str]) -> str:
    """Clean a table cell, handling newlines and empty values."""
    if cell is None:
        return ""
    # Flatten newlines to spaces for markdown compatibility
    return str(cell).replace("\n", " ").replace("\r", "").strip()


def is_valid_table(rows: list[list[str]]) -> bool:
    """Check if extracted data represents a valid table."""
    if len(rows) < MIN_ROWS:
        return False

    # Count non-empty columns in the first row (header)
    header = rows[0]
    non_empty_cols = sum(1 for cell in header if clean_cell(cell))

    if non_empty_cols < MIN_COLUMNS:
        return False

    # Check that at least some rows have meaningful content
    meaningful_rows = 0
    for row in rows:
        non_empty = sum(1 for cell in row if clean_cell(cell))
        if non_empty >= 2:  # At least 2 non-empty cells
            meaningful_rows += 1

    # At least 50% of rows should have meaningful content
    if meaningful_rows < len(rows) * 0.5:
        return False

    return True


def rows_to_markdown(rows: list[list[str]]) -> str:
    """Convert table rows to markdown format.

    First row becomes the header.
    """
    if not rows or len(rows) == 0:
        return ""

    # Clean all cells
    cleaned_rows = [[clean_cell(cell) for cell in row] for row in rows]

    # Remove rows that are completely empty
    cleaned_rows = [row for row in cleaned_rows if any(cell for cell in row)]

    if len(cleaned_rows) == 0:
        return ""

    if len(cleaned_rows) == 1:
        # Single row table - treat as header only
        header = cleaned_rows[0]
        header_line = "| " + " | ".join(header) + " |"
        separator = "| " + " | ".join(["---"] * len(header)) + " |"
        return f"{header_line}\n{separator}"

    # Determine maximum column count
    max_cols = max(len(row) for row in cleaned_rows)

    # Multi-row table
    header = cleaned_rows[0]
    # Pad header if needed
    header = header + [""] * (max_cols - len(header))
    data_rows = cleaned_rows[1:]

    header_line = "| " + " | ".join(header) + " |"
    separator = "| " + " | ".join(["---"] * len(header)) + " |"

    lines = [header_line, separator]
    for row in data_rows:
        # Ensure row has same number of cells as header
        padded_row = row + [""] * (max_cols - len(row))
        trimmed_row = padded_row[:max_cols]
        lines.append("| " + " | ".join(trimmed_row) + " |")

    return "\n".join(lines)


def extract_tables_from_page(page, page_num: int) -> list[dict]:
    """Extract all tables from a single page.

    Tries line-based detection first (for tables with visible borders),
    then falls back to text-based detection for borderless tables.
    """
    tables = []
    seen_table_areas = set()  # Track table locations to avoid duplicates

    def area_key(table_bbox) -> str:
        """Create a key for table area to detect duplicates."""
        if table_bbox:
            return f"{int(table_bbox[0])},{int(table_bbox[1])},{int(table_bbox[2])},{int(table_bbox[3])}"
        return ""

    # First, try line-based extraction (for tables with borders)
    try:
        line_tables = page.extract_tables(TABLE_SETTINGS_LINES)
        for table_index, table in enumerate(line_tables):
            if not table or len(table) == 0:
                continue

            # Filter out empty rows
            rows = [row for row in table if row and any(cell for cell in row)]

            if not is_valid_table(rows):
                continue

            # Convert to clean string format
            clean_rows = [[clean_cell(cell) for cell in row] for row in rows]

            # Generate markdown
            markdown = rows_to_markdown(rows)

            if markdown:  # Only add if markdown was generated
                tables.append({
                    "page": page_num,
                    "tableIndex": len(tables),
                    "rows": clean_rows,
                    "markdown": markdown,
                })
    except Exception as e:
        print(f"Warning: Line-based extraction failed on page {page_num}: {e}", file=sys.stderr)

    # If no tables found with lines, try text-based extraction
    if len(tables) == 0:
        try:
            text_tables = page.extract_tables(TABLE_SETTINGS_TEXT)
            for table_index, table in enumerate(text_tables):
                if not table or len(table) == 0:
                    continue

                # Filter out empty rows
                rows = [row for row in table if row and any(cell for cell in row)]

                if not is_valid_table(rows):
                    continue

                # Convert to clean string format
                clean_rows = [[clean_cell(cell) for cell in row] for row in rows]

                # Generate markdown
                markdown = rows_to_markdown(rows)

                if markdown:  # Only add if markdown was generated
                    tables.append({
                        "page": page_num,
                        "tableIndex": len(tables),
                        "rows": clean_rows,
                        "markdown": markdown,
                    })
        except Exception as e:
            print(f"Warning: Text-based extraction failed on page {page_num}: {e}", file=sys.stderr)

    return tables


def extract_tables(pdf_path: str, page: Optional[int] = None) -> dict:
    """
    Extract tables from a PDF file.

    Args:
        pdf_path: Path to the PDF file
        page: Optional specific page number (1-indexed)

    Returns:
        Dictionary with 'tables' array and optional 'error' field
    """
    result = {"tables": []}

    try:
        with pdfplumber.open(pdf_path) as pdf:
            total_pages = len(pdf.pages)

            if page is not None:
                # Extract from specific page (1-indexed)
                if page < 1 or page > total_pages:
                    result["error"] = f"Page {page} out of range. PDF has {total_pages} pages."
                    return result

                page_obj = pdf.pages[page - 1]
                result["tables"] = extract_tables_from_page(page_obj, page)
            else:
                # Extract from all pages
                for page_num, page_obj in enumerate(pdf.pages, start=1):
                    tables = extract_tables_from_page(page_obj, page_num)
                    result["tables"].extend(tables)

    except FileNotFoundError:
        result["error"] = f"File not found: {pdf_path}"
    except Exception as e:
        result["error"] = f"Error processing PDF: {str(e)}"

    return result


def main():
    parser = argparse.ArgumentParser(
        description="Extract tables from PDF files using pdfplumber"
    )
    parser.add_argument("pdf_path", help="Path to the PDF file")
    parser.add_argument(
        "--page",
        type=int,
        default=None,
        help="Specific page number to extract (1-indexed)",
    )

    args = parser.parse_args()

    result = extract_tables(args.pdf_path, args.page)

    # Output JSON to stdout
    print(json.dumps(result, ensure_ascii=False, indent=2))

    # Exit with error code if there was an error
    if "error" in result:
        sys.exit(1)


if __name__ == "__main__":
    main()
