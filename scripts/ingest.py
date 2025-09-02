
from dotenv import load_dotenv
import os
load_dotenv()

from langchain_community.document_loaders import (
    TextLoader, PyPDFLoader, CSVLoader,
    UnstructuredWordDocumentLoader, UnstructuredMarkdownLoader
)
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_openai import OpenAIEmbeddings
from langchain_chroma import Chroma
from langchain.docstore.document import Document
import os
import xml.etree.ElementTree as ET


# Define the document path
docs_path = "docs/"
all_documents = []

# Walk through all files recursively
for root, _, files in os.walk(docs_path):
    for file in files:
        filepath = os.path.join(root, file)
        ext = file.split('.')[-1].lower()

        try:
            if ext == "txt":
                if "license" in file.lower():
                    continue  # Skip LICENSE files
                loader = TextLoader(filepath)
                docs = loader.load()

            elif ext == "xml":
                # Parse MedQuAD-style XML files
                tree = ET.parse(filepath)
                root_element = tree.getroot()

                question = root_element.findtext("question")
                answer = root_element.findtext("answer")

                if question and answer:
                    content = f"Q: {question.strip()}\nA: {answer.strip()}"
                    docs = [Document(page_content=content, metadata={"source": filepath})]
                else:
                    print(f"Skipped incomplete QA in: {filepath}")
                    continue

            elif ext == "pdf":
                loader = PyPDFLoader(filepath)
                docs = loader.load()

            elif ext == "csv":
                loader = CSVLoader(filepath)
                docs = loader.load()

            elif ext == "docx":
                loader = UnstructuredWordDocumentLoader(filepath)
                docs = loader.load()

            elif ext == "md":
                loader = UnstructuredMarkdownLoader(filepath)
                docs = loader.load()

            else:
                print(f"Skipped unsupported file type: {file}")
                continue

            all_documents.extend(docs)

        except Exception as e:
            print(f"Failed to load {file}: {e}")

# Split documents into chunks
text_splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=100)
split_docs = text_splitter.split_documents(all_documents)

# Embed and store in ChromaDB
embedding = OpenAIEmbeddings(api_key=os.getenv("OPENAI_API_KEY"), model="text-embedding-3-small")
vectorstore = Chroma.from_documents(split_docs, embedding=embedding, persist_directory="chroma_store")

print("Documents ingested and stored.")