import os

from flask import Blueprint, abort, jsonify

from .auth import login_required

REPORTS_DIR = os.environ.get("REPORTS_DIR", "/var/lib/reports")

reports = Blueprint("reports", __name__)


@reports.get("/reports")
@login_required
def list_reports():
    names = sorted(n for n in os.listdir(REPORTS_DIR) if n.endswith(".csv"))
    return jsonify(names)
