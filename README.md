# 💬 **Nanize • Chat**

**Nanize** is a **web-based chat platform** designed for **real-time AI interaction** with a **modern UI** and **streamed responses**.  
It provides a **threaded chat interface**, **rich outputs** (charts, diagrams, tables, images, animations), and integrates with **Flask**, **OpenAI**, **Chroma**, and **Redis** for **fast, contextual answers**.

Hosted at: [GitHub Repository](https://github.com/yourusername/nanize-chat)

Nanize allows users to **ask questions**, receive **AI-generated responses** streamed via **Server-Sent Events (SSE)**, and view **rich media content** inline.  
It is built for **speed**, **clarity**, and **scalability**, making it a great foundation for **assistants**, **knowledge bases**, or **educational tools**.

---

## ✨ **Key Features**

- **Real-Time Response Streaming**  
  Uses **Server-Sent Events (SSE)** to deliver **token-by-token AI responses**.

- **Threaded Chat History**  
  Local storage with **thread titles**, **timestamps**, and **deletion support**.

- **Rich Outputs**  
  Supports **Markdown**, **Vega-Lite charts**, **Mermaid diagrams**, **tables**, **images**, and **Lottie animations**.

- **Interactive Chat Interface**  
  Includes **compact landing view**, **sidebar with history**, and **responsive composer**.

- **Contextual AI Responses**  
  Augments user prompts with **retrieved context** from **Chroma vector store**.

- **Response Caching**  
  Uses **Redis** to cache responses keyed by **SHA-256** for faster repeat queries.

- **Responsive Design**  
  Optimized for **desktop and mobile** with **adaptive layouts**.

---

## 🖼 **Screenshots**

- **Landing Screen**  
  Background video, **hero prompt**, and **composer input**.  
  ![Landing](static/screenshots/screenshot1.png)

- **Chat Interface with Rich Outputs**  
  Inline **charts**, **tables**, and **diagrams** embedded in conversation.  
  ![Chat](static/screenshots/screenshot2.png)

---

## ✅ **Prerequisites**

- **Python** 3.10 or higher
- **Redis** server
- **OpenAI API key**
- **Modern browser** (supports **EventSource** + **WebGL**)

---

## 🛠 **Installation**

### **1. Clone the Repository**

```bash
git clone https://github.com/yourusername/nanize-chat.git
cd nanize-chat
```
