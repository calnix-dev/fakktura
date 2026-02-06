import time, random

def get_parking_services():
    return [
        {"id": "autopay", "name": "Onepark / Autopay"},
        {"id": "aimo", "name": "Aimo Park"},
        {"id": "apcoa", "name": "Apcoa Flow"},
        {"id": "riverty", "name": "Riverty / Arvato"},
        {"id": "falu", "name": "Falu P-Service"}
    ]

class MockParkingService:
    def fetch_vehicle(self, plate):
        time.sleep(0.6)
        cars = [
            {"make": "Tesla", "model": "Model 3", "year": "2023"},
            {"make": "Volkswagen", "model": "ID.4", "year": "2022"},
            {"make": "Volvo", "model": "XC40", "year": "2021"},
            {"make": "Toyota", "model": "Rav4", "year": "2019"},
            {"make": "BMW", "model": "i4", "year": "2024"}
        ]
        # Returns a consistent car for the same plate string length, 
        # or just random for testing.
        return random.choice(cars)

    def check_parking(self, provider_id, plate):
        # Simulated check time
        time.sleep(random.uniform(0.7, 1.5))
        # 20% chance of True (Parking found)
        return random.random() < 0.20
    
import requests
import os

import requests
import os

class ParkingService:
    def __init__(self):
        # SVV API Key from your .env
        self.api_key = os.getenv("SVV_API_KEY")
        # New technical endpoint from the documentation
        self.base_url = "https://akfell-datautlevering.atlas.vegvesen.no/enkeltoppslag/kjoretoydata"

    def fetch_vehicle(self, plate):
        if not self.api_key:
            return {"make": "Feil", "model": "Mangler API-nøkkel", "year": "-", "color": "-"}

        # SVV requires the prefix 'Apikey ' followed by the key
        headers = {
            "SVV-Authorization": f"Apikey {self.api_key}",
            "Accept": "application/json"
        }
        
        try:
            clean_plate = plate.upper().replace(" ", "")
            # Query parameter: kjennemerke
            response = requests.get(
                f"{self.base_url}?kjennemerke={clean_plate}", 
                headers=headers, 
                timeout=5
            )

            if response.status_code == 200:
                data = response.json()
                
                # Navigate the JSON structure based on the documentation
                teknisk = data.get("tekniskKjoretoy", {})
                
                # Make & Model
                merke = teknisk.get("merke", ["Ukjent"])[0]
                modell = teknisk.get("handelsbetegnelse", [""])[0]
                
                # Color (found under karosseriOgLasteplan)
                karosseri = teknisk.get("karosseriOgLasteplan", {})
                farge = karosseri.get("r_farge", ["-"])[0]
                
                # Year (found under registrering -> førstegangsregistrertNorge)
                reg_info = data.get("registrering", {})
                reg_date = reg_info.get("førstegangsregistrertNorge", "0000")
                year = reg_date[:4]

                return {
                    "make": merke,
                    "model": modell,
                    "year": year,
                    "color": farge
                }
            elif response.status_code == 404:
                return {"make": "Ikke funnet", "model": "Sjekk skiltnummer", "year": "-", "color": "-"}
            else:
                return {"make": "SVV Error", "model": f"Status {response.status_code}", "year": "-", "color": "-"}

        except Exception as e:
            print(f"SVV Connection Error: {e}")
            return {"make": "Tilkoblingsfeil", "model": "Prøv igjen senere", "year": "-", "color": "-"}