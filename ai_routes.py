# nanize_routes.py
from dotenv import load_dotenv
import os
load_dotenv()

# Disable Chroma telemetry
os.environ["ANONYMIZED_TELEMETRY"] = "False"

from flask import Blueprint, request, jsonify, stream_with_context, Response
import redis
import hashlib
import json
from openai import OpenAI
from langchain_openai import OpenAIEmbeddings
from langchain_chroma import Chroma

# Create a Flask blueprint
nanize_bp = Blueprint("nanize", __name__)

# Initialize the OpenAI client
openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# Load persisted vectorstore
embedding = OpenAIEmbeddings(api_key=os.getenv("OPENAI_API_KEY"), model="text-embedding-3-small")
vectorstore = Chroma(persist_directory="chroma_store", embedding_function=embedding)

# Redis connection (only from REDIS_URL now)
redis_url = os.getenv("REDIS_URL")
if not redis_url:
    raise ValueError("REDIS_URL must be set in .env")
redis_client = redis.from_url(redis_url, decode_responses=True)

def hash_prompt(prompt):
    """Create a consistent hash key for a given prompt"""
    return hashlib.sha256(prompt.encode('utf-8')).hexdigest()

@nanize_bp.route("/api/ask", methods=["POST"])
def ask():
    data = request.get_json()
    prompt = data.get("prompt")
    if not prompt:
        return jsonify({"error": "No prompt provided"}), 400

    # Hash prompt for caching
    cache_key = f"nanize_response:{hash_prompt(prompt)}"

    # Check cache first
    cached_response = redis_client.get(cache_key)
    if cached_response:
        def cached_stream():
            yield f"data: {json.dumps({'text': cached_response})}\n\n"
        return Response(stream_with_context(cached_stream()), mimetype="text/event-stream")

    # Embed and search for relevant docs
    docs = vectorstore.similarity_search(prompt, k=3)
    context = "\n\n---\n\n".join([doc.page_content for doc in docs if doc.page_content.strip()])

    # Construct full prompt
    if context:
        full_prompt = (
            "You are Nanize, a friendly assistant. "
            "Format the entire answer in Markdown with clear headings (#, ##), bold text, and bullet lists. "
            "Do not wrap Markdown in code fences. Keep it conversational but clear.\n\n"
            f"Context:\n{context}\n\n"
            f"User's Question: {prompt}\n\n"
            "Your Answer:"
        )
    else:
        full_prompt = (
            "You are Nanize, a friendly assistant. "
            "Format the entire answer in Markdown with clear headings (#, ##), bold text, and bullet lists. "
            "Do not wrap Markdown in code fences. Keep it conversational but clear.\n\n"
            f"User's Question: {prompt}\n\n"
            "Your Answer:"
        )

    # Streamed response for uncached prompts
    def generate():
        full_response = ""
        stream = openai_client.chat.completions.create(
            model=os.getenv("OPENAI_MODEL"),
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are Nanize, a helpful and approachable assistant. "
                        "Always output Markdown with headings, bold, and lists. "
                        "Never use code fences unless explicitly asked."
                    ),
                },
                {"role": "user", "content": full_prompt}
            ],
            stream=True,
            temperature=0.7
        )

        for chunk in stream:
            if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
                content = chunk.choices[0].delta.content
                full_response += content
                yield f"data: {json.dumps({'text': content})}\n\n"

        redis_client.setex(cache_key, 3600, full_response)

    return Response(stream_with_context(generate()), mimetype="text/event-stream")
