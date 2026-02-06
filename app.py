import os
import time
import random
import requests
from flask import Flask, render_template, jsonify
from flask_caching import Cache
from dotenv import load_dotenv

# Initialize environment and Flask
load_dotenv()
app = Flask(__name__)

# --- Cache Configuration ---
cache = Cache(config={'CACHE_TYPE': 'SimpleCache'})
cache.init_app(app)

# --- Config & Toggles ---
SVV_API_KEY = os.getenv("SVV_API_KEY")
SVV_URL = "https://akfell-datautlevering.atlas.vegvesen.no/enkeltoppslag/kjoretoydata"

MOCK_SVV = os.getenv("MOCK_SVV", "False").lower() == "true"
MOCK_DEFAULT = os.getenv("MOCK_PROVIDERS_DEFAULT", "True").lower() == "true"
REAL_LIST = [p.strip() for p in os.getenv("REAL_PROVIDERS", "").split(",") if p.strip()]

PROVIDERS = [
    {"id": "autopay", "name": "Autopay.io"},
    {"id": "timepark", "name": "TimePark"},
    {"id": "onepark", "name": "Onepark"},
    {"id": "aimo", "name": "Aimo Park"},
    {"id": "apcoa", "name": "Apcoa Flow"},
    {"id": "parkpay", "name": "ParkPay"},
    {"id": "parkly", "name": "Parkly"}
]

@app.route('/')
def index():
    return render_template('index.html', providers=PROVIDERS)

@app.route('/api/lookup/<plate>')
@cache.memoize(timeout=86400)
def api_get_vehicle(plate):
    clean_plate = plate.upper().replace(" ", "")

    if MOCK_SVV:
        return jsonify({"vehicle": {"make": "MOCK-BIL", "model": "TEST", "year": "2024", "color": "GRØNN"}})

    headers = {
        "SVV-Authorization": f"Apikey {SVV_API_KEY}",
        "Accept": "application/json"
    }
    
    try:
        url = f"{SVV_URL}?kjennemerke={clean_plate}"
        response = requests.get(url, headers=headers, timeout=5)

        if response.status_code == 200:
            data = response.json()
            if not data.get("kjoretoydataListe"):
                return jsonify({"error": "Ikke funnet"}), 404
            
            # Accessing the first vehicle in the response list
            car = data["kjoretoydataListe"][0]
            teknisk = car.get("godkjenning", {}).get("tekniskGodkjenning", {}).get("tekniskeData", {})
            
            return jsonify({
                "vehicle": {
                    "make": teknisk.get("generelt", {}).get("merke", [{}])[0].get("merke", "Ukjent"),
                    "model": teknisk.get("generelt", {}).get("handelsbetegnelse", ["Ukjent"])[0],
                    "year": car.get("forstegangsregistrering", {}).get("registrertForstegangNorgeDato", "0000")[:4],
                    "color": teknisk.get("karosseriOgLasteplan", {}).get("rFarge", [{}])[0].get("kodeNavn", "-")
                }
            })
        
        return jsonify({"error": "SVV utilgjengelig"}), response.status_code

    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/check/<provider_id>/<plate>')
def api_check_provider(provider_id, plate):
    # Logic to switch between real and mock per provider
    should_mock = MOCK_DEFAULT if provider_id not in REAL_LIST else False

    if should_mock:
        time.sleep(random.uniform(0.4, 0.9))
        return jsonify({"status": random.random() < 0.15}) # 15% chance of hit
    
    # Placeholder for real integration logic
    return jsonify({"status": False})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)