const API_KEY = "AQ.Ab8RN6Iych1FQlpsdPw3UTN3VmrzxvJ0eSG-OySXvDo3aKvLKQ";
// fdgdttndtn
async function test() {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ contents: [{ parts: [{ text: "hello" }] }] })
    });
    const data = await response.json();
    console.log("Status:", response.status);
    console.log("Response:", JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Error:", error);
  }
}

test();
