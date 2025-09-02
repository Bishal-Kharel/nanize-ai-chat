# app.py
from dotenv import load_dotenv
from flask import Flask, render_template
import os

# Load environment variables
load_dotenv()

# Import Nanize blueprint
from ai_routes import nanize_bp

app = Flask(__name__)
app.register_blueprint(nanize_bp)

@app.route("/")
def index():
    return render_template("index.html")

if __name__ == "__main__":
    app.run(debug=True)
