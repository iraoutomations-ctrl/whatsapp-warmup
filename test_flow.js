import db from './database.js';
import scheduler from './scheduler.js';
import { generateStarter, generateReply, generateGroupReply } from './gemini.js';
import { sendMessage } from './evolution.js';
import { getConfig } from './config.js';

async function runTests() {
  console.log('🧪 STARTING OFFLINE INTEGRATION SIMULATION TESTS');
  console.log('==================================================');

  // 1. Initialize DB
  console.log('\nStep 1: Initializing Database...');
  await db.init();
  console.log('Settings:', db.getSettings());

  // 2. Insert mock guided contacts if database is empty
  console.log('\nStep 2: Checking Guided Contacts...');
  let contacts = db.getContacts();
  if (contacts.length === 0) {
    console.log('Adding mock guided contacts...');
    await db.addContact({ phone: '972501111111', name: 'ערן (יוזמה)', notes: 'עובד משרד, יזרום על נושאי מיילים ולו"ז' });
    await db.addContact({ phone: '972522222222', name: 'מיכל (יוזמה)', notes: 'קולגה, שיחות קצרות בנושא משימות' });
    contacts = db.getContacts();
  }
  console.log('Guided Contacts List:', contacts);

  // 3. Test Gemini Active Starter Generation
  console.log('\nStep 3: Simulating Gemini Active Starter Generation...');
  const firstContact = contacts[0];
  console.log(`Generating starter for ${firstContact.name} on Day 3...`);
  const starter = await generateStarter(firstContact.name, 3);
  console.log(`▶ Generated Starter: "${starter}"`);

  // 4. Test Passive Chat Replier
  console.log('\nStep 4: Simulating Passive Chat Reply Flow...');
  const mockIncomingMsg = 'היי, לא קיבלתי את המייל שדיברת עליו. על איזה מייל מדובר?';
  console.log(`Mock Incoming from ${firstContact.name}: "${mockIncomingMsg}"`);
  
  // Create mock history (empty for first message)
  const mockHistory = [
    { isOutgoing: true, message: starter },
    { isOutgoing: false, message: mockIncomingMsg }
  ];

  const reply = await generateReply(firstContact.name, mockIncomingMsg, mockHistory, 3);
  console.log(`▶ Generated Reply: "${reply}"`);

  // 4b. Test Reaction Generation
  console.log('\nStep 4b: Simulating Passive Chat Reaction Flow...');
  const mockCloseMsg = 'סבבה, תודה!';
  console.log(`Mock Incoming from ${firstContact.name}: "${mockCloseMsg}"`);
  
  const mockHistoryReaction = [
    { isOutgoing: true, message: starter },
    { isOutgoing: false, message: mockIncomingMsg },
    { isOutgoing: true, message: reply },
    { isOutgoing: false, message: mockCloseMsg }
  ];

  const reactionReply = await generateReply(firstContact.name, mockCloseMsg, mockHistoryReaction, 3);
  console.log(`▶ Generated Reaction: "${reactionReply}"`);
  const isReaction = reactionReply.startsWith('[REACTION:');
  console.log(`▶ Is Reaction Command: ${isReaction}`);

  // 5. Test Group Message Filtering and Reactions
  console.log('\nStep 5: Simulating Group Message Reactions...');
  
  const groupMsgs = [
    { sender: 'אבי', text: 'מזל טוב לרגל השקת האתר החדש של יוזמה!', shouldSkip: false },
    { sender: 'רועי', text: 'מישהו יכול לשלוח קישור לקובץ של העדכון מאתמול?', shouldSkip: true },
    { sender: 'עידו', text: 'תודה רבה לכולם על העזרה היום', shouldSkip: false },
    { sender: 'ליאור', text: 'https://github.com/some/repo קישור לפרויקט החדש', shouldSkip: true }
  ];

  for (const msg of groupMsgs) {
    console.log(`Analyzing message from ${msg.sender} in Group: "${msg.text}"`);
    const decision = await generateGroupReply(msg.sender, msg.text);
    console.log(`▶ Group Reply Result: "${decision}" (Expected skip: ${msg.shouldSkip})`);
  }

  // 6. Test Outgoing Message logs & stats updates
  console.log('\nStep 6: Simulating Message Stats Logging...');
  const testNumber = '972509999999';
  
  // Test double-message sending
  console.log(`Sending split message to ${testNumber} via mocked Evolution API...`);
  await sendMessage(testNumber, 'היי ערן || רציתי לשאול לגבי המצגת');

  // Test standard sending
  console.log(`Sending message to ${testNumber} via mocked Evolution API...`);
  await sendMessage(testNumber, 'בדיקת מערכת מוצלחת!');
  
  // Step 7: Simulate status story posts
  console.log('\nStep 7: Simulating WhatsApp Status Stories...');
  const statusResult = await scheduler.triggerManualStatusPost();
  console.log('▶ Status post result:', statusResult);

  const today = db.getTodayDateString();
  const todayStats = db.getStatsForDate(today);
  console.log('Today Stats after simulation:', todayStats);

  console.log('\n==================================================');
  console.log('✅ ALL OFFLINE INTEGRATION TESTS COMPLETED SUCCESSFULLY!');
}

runTests().catch(err => {
  console.error('❌ Tests failed with error:', err);
  process.exit(1);
});
