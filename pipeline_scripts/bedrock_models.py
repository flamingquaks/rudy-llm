import base64
import json
import logging
from io import BytesIO
from typing import List, Union, Generator, Iterator

import boto3
import os
import requests

from pydantic import BaseModel

from utils.pipelines.main import pop_system_message

class Pipeline:
    def __init__(self):
        self.type = "manifold"
        self.name = "Bedrock: "
        # Initialize clients for both regions
        self.east_bedrock = boto3.client("bedrock", region_name="us-east-1")
        self.east_bedrock_runtime = boto3.client("bedrock-runtime", region_name="us-east-1")
        self.west_bedrock = boto3.client("bedrock", region_name="us-west-2")
        self.west_bedrock_runtime = boto3.client("bedrock-runtime", region_name="us-west-2")
        
        self.pipelines = self.get_models()

    async def on_startup(self):
        print(f"on_startup:{__name__}")

    async def on_shutdown(self):
        print(f"on_shutdown:{__name__}")

    async def on_valves_updated(self):
        # No valves to update now.
        print(f"on_valves_updated:{__name__}")
        self.pipelines = self.get_models()

    # Helper: get model's region by model_id
    def get_model_region(self, model_id: str) -> str:
        for model in self.pipelines:
            if model["id"] == model_id:
                return model["region"]
        return "us-east-1"

    # Helper: select runtime client based on region
    def get_runtime_client(self, region: str):
        return self.east_bedrock_runtime if region == "us-east-1" else self.west_bedrock_runtime

    # Get east foundation models (active only)
    def get_east_models(self) -> List[dict]:
        try:
            response = self.east_bedrock.list_foundation_models()
            models = [
                {
                    "id": model["modelId"],
                    "name": model["modelName"],
                    "region": "us-east-1",
                    "description": f"{model['modelName']} - us-east-1"
                }
                for model in response["modelSummaries"]
                if model.get("modelLifecycle", {}).get("status") == 'ACTIVE'
            ]
            return models
        except Exception as e:
            print(f"Error fetching east models: {e}")
            return [{"id": "error", "name": "Error fetching east models", "region": "us-east-1"}]

    # Get cross-region inference profiles (exclude east ones)
    def get_cross_region_profiles(self, east_ids: set) -> List[dict]:
        try:
            response = self.east_bedrock.list_inference_profiles()  # assumed call
            profiles = [
                {
                    "id": profile["modelId"],
                    "name": profile["modelName"],
                    "region": profile.get("region", "us-east-1"),
                    "description": f"{model['modelName']} - us-east-1 (cross-region)"
                }
                for profile in response.get("profiles", [])
                if profile.get("status") == "ACTIVE" and profile["modelId"] not in east_ids
            ]
            return profiles
        except Exception as e:
            print(f"Error fetching cross-region profiles: {e}")
            return []

    # Get west foundation models (active and not in east)
    def get_west_models(self, east_ids: set) -> List[dict]:
        try:
            response = self.west_bedrock.list_foundation_models()
            models = [
                {
                    "id": model["modelId"],
                    "name": model["modelName"],
                    "region": "us-west-2",
                    "description": f"{model['modelName']} - us-west-2"
                }
                for model in response["modelSummaries"]
                if model.get("modelLifecycle", {}).get("status") == 'ACTIVE' and model["modelId"] not in east_ids
            ]
            return models
        except Exception as e:
            print(f"Error fetching west models: {e}")
            return [{"id": "error", "name": "Error fetching west models", "region": "us-west-2"}]

    # Combine models from east, cross-region, and west
    def get_models(self) -> List[dict]:
        east_models = self.get_east_models()
        east_ids = {model["id"] for model in east_models}
        cross_profiles = self.get_cross_region_profiles(east_ids)
        west_models = self.get_west_models(east_ids)
        return east_models + cross_profiles + west_models

    def pipe(
        self, user_message: str, model_id: str, messages: List[dict], body: dict
    ) -> Union[str, Generator, Iterator]:
        print(f"pipe:{__name__}")
        system_message, messages = pop_system_message(messages)
        logging.info(f"pop_system_message: {json.dumps(messages)}")
        try:
            processed_messages = []
            image_count = 0
            for message in messages:
                processed_content = []
                if isinstance(message.get("content"), list):
                    for item in message["content"]:
                        if item["type"] == "text":
                            processed_content.append({"text": item["text"]})
                        elif item["type"] == "image_url":
                            if image_count >= 20:
                                raise ValueError("Maximum of 20 images per API call exceeded")
                            processed_image = self.process_image(item["image_url"])
                            processed_content.append(processed_image)
                            image_count += 1
                else:
                    processed_content = [{"text": message.get("content", "")}]
                processed_messages.append({"role": message["role"], "content": processed_content})

            payload = {
                "modelId": model_id,
                "messages": processed_messages,
                "system": [{'text': system_message if system_message else 'you are an intelligent ai assistant'}],
                "inferenceConfig": {"temperature": body.get("temperature", 0.5)},
                "additionalModelRequestFields": {"top_k": body.get("top_k", 200), "top_p": body.get("top_p", 0.9)}
            }
            # Determine runtime client based on model region
            region = self.get_model_region(model_id)
            if body.get("stream", False):
                return self.stream_response(model_id, payload, region)
            else:
                return self.get_completion(model_id, payload, region)
        except Exception as e:
            return f"Error: {e}"

    def process_image(self, image: str):
        img_stream = None
        if image["url"].startswith("data:image"):
            if ',' in image["url"]:
                base64_string = image["url"].split(',')[1]
            image_data = base64.b64decode(base64_string)
            img_stream = BytesIO(image_data)
        else:
            img_stream = requests.get(image["url"]).content
        return {
            "image": {"format": "png" if image["url"].endswith(".png") else "jpeg",
                      "source": {"bytes": img_stream.read()}}
        }

    def stream_response(self, model_id: str, payload: dict, region: str) -> Generator:
        # Use proper runtime client based on region
        client = self.get_runtime_client(region)
        if "system" in payload:
            del payload["system"]
        if "additionalModelRequestFields" in payload:
            del payload["additionalModelRequestFields"]
        streaming_response = client.converse_stream(**payload)
        for chunk in streaming_response["stream"]:
            if "contentBlockDelta" in chunk:
                yield chunk["contentBlockDelta"]["delta"]["text"]

    def get_completion(self, model_id: str, payload: dict, region: str) -> str:
        client = self.get_runtime_client(region)
        response = client.converse(**payload)
        return response['output']['message']['content'][0]['text']
