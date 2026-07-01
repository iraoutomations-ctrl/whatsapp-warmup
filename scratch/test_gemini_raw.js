import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

async function testRaw() {
  const apiKey = process.env.GEMINI_API_KEY;
  console.log('Using API Key:', apiKey ? apiKey.substring(0, 10) + '...' : 'None');
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  
  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: 'אנחנו ביום מספר 3 של תהליך החימום. שם איש הקשר שאליו שולחים: ערן. נסח הודעת פתיחה ספונטנית אחת בעברית. אל תוסיף שום הסבר, אלא רק את הודעת הוואטסאפ עצמה.' }]
      }
    ],
    systemInstruction: {
      parts: [{ text: 'אתה עוזר בניסוח הודעת פתיחה ספונטנית בעברית עבור מספר וואטסאפ של משרד יוזמה, במטרה לחמם את המספר מול מנגנוני ה-Anti-Spam של וואטסאפ. ההודעה צריכה להיראות כאילו נשלחה על ידי בן אדם אמיתי, עובד משרד, לחבר או קולגה. חוקים נוקשים: 1. הודעה קצרה מאוד (משפט אחד, עד 10 מילים). 2. שפה טבעית, יומיומית, ספונטנית ועברית מדוברת. 3. ללא סימני קריאה מוגזמים, ללא אימוג\'ים בכלל, ללא פניות רשמיות.' }]
    },
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: 150
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    const data = await response.json();
    console.log('Raw JSON Response:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error:', err);
  }
}

testRaw();
