"""
Optional HTTP server for table extraction.
To be implemented in Phase 1.5.
"""

from flask import Flask, request, jsonify

app = Flask(__name__)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/extract", methods=["POST"])
def extract():
    """
    Extract tables from uploaded PDF.

    Expected request body:
        - pdf_path: Path to the PDF file
    """
    # Placeholder - to be implemented
    return jsonify({"tables": [], "error": "Not implemented"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
