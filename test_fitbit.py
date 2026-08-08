import json
import requests
from google_auth_oauthlib.flow import InstalledAppFlow

# Google Health API scopes for activity, metrics, and sleep
SCOPES = [
    'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
    'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
    'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
]

def authenticate():
    """Starts local server OAuth flow using client_secret.json."""
    flow = InstalledAppFlow.from_client_secrets_file('client_secret.json', SCOPES)
    creds = flow.run_local_server(port=8080)
    return creds.token

def get_identity_and_steps(access_token):
    """Fetches user identity and recent step data from Google Health API."""
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json"
    }
    
    # Check linked account identity
    identity_url = "https://health.googleapis.com/v4/users/me/identity"
    identity_res = requests.get(identity_url, headers=headers).json()
    
    # Query steps data points
    steps_url = "https://health.googleapis.com/v4/users/me/dataTypes/steps/dataPoints"
    steps_res = requests.get(steps_url, headers=headers).json()
    
    return {
        "identity": identity_res,
        "steps": steps_res
    }

if __name__ == "__main__":
    print("Launching browser for Google OAuth authorization...")
    token = authenticate()
    print("Authenticated! Fetching Fitbit data from Google Health API...")
    
    results = get_identity_and_steps(token)
    print(json.dumps(results, indent=2))