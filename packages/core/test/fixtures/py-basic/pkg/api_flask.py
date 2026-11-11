from flask import Flask

app = Flask(__name__)


@app.route("/hello", methods=["GET", "POST"])
def hello():
    return "hi"


@app.route("/plain")
def plain():
    return "plain"
