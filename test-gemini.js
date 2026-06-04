const API_KEY = "AIzaSyByIWhGIn1AkGroPcxJF7n5kLlufcp8t3U";
const userMessage = "hello";

async function test() {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`);
    const data = await response.json();
    const models = data.models.filter(m => m.supportedGenerationMethods.includes('generateContent')).map(m => m.name);
    console.log("Models:", models.slice(0, 10));
  } catch (error) {
    console.error("Error:", error);
  }
}

test();
