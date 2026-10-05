from flask import Flask

from .reports import reports


def create_app() -> Flask:
    app = Flask(__name__)
    app.register_blueprint(reports)
    return app
