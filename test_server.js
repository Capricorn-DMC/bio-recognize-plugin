/**
 * Test Enhanced BioRecognize Server
 */

import http from 'http';

const BASE_URL = 'http://127.0.0.1:8765';

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function test() {
  console.log('\n========================================');
  console.log('  Enhanced BioRecognize Tests');
  console.log('========================================\n');

  // Test 1: Health
  console.log('[Test 1] Health Check');
  const health = await request('GET', '/health');
  console.log('  Status:', health.data.status);

  // Test 2: Add User
  console.log('\n[Test 2] Add User');
  const addUser = await request('POST', '/users', {
    user_id: 'test_user_001',
    name: 'Test User'
  });
  console.log('  Result:', addUser.data.status);

  // Test 3: Register Face
  console.log('\n[Test 3] Register Face');
  const regFace = await request('POST', '/register/face', {
    user_id: 'test_user_001',
    image_path: 'C:/photos/test.jpg'
  });
  console.log('  Result:', JSON.stringify(regFace.data));

  // Test 4: Get Config
  console.log('\n[Test 4] Get Config');
  const getConfig = await request('GET', '/config');
  console.log('  Config loaded:', !!getConfig.data.config);

  // Test 5: Update Config - Enable detection
  console.log('\n[Test 5] Enable Detection');
  const updateConfig = await request('POST', '/config', {
    enabled: true,
    faceEnabled: true,
    absentThreshold: 30,
    detectionInterval: 5000
  });
  console.log('  Config updated:', updateConfig.data.status);

  // Test 6: Screen Control - Turn On
  console.log('\n[Test 6] Screen On');
  const turnOn = await request('POST', '/screen', { action: 'on' });
  console.log('  Turned on:', !turnOn.data.isBlack);

  // Test 7: Screen Control - Black
  console.log('\n[Test 7] Screen Black');
  const blackScreen = await request('POST', '/screen', { action: 'off' });
  console.log('  Black:', blackScreen.data.isBlack);

  // Test 8: Screen Control - Turn On again
  console.log('\n[Test 8] Screen On Again');
  const turnOn2 = await request('POST', '/screen', { action: 'on' });
  console.log('  Turned on:', !turnOn2.data.isBlack);

  // Test 12: Presence Status
  console.log('\n[Test 12] Presence Status');
  const presence = await request('GET', '/presence');
  console.log('  State:', presence.data.state);
  console.log('  Screen:', JSON.stringify(presence.data.screen));

  // Test 13: List Users
  console.log('\n[Test 13] List Users');
  const listUsers = await request('GET', '/users');
  console.log('  Users:', listUsers.data.users?.length || 0);

  // Test 14: Cleanup
  console.log('\n[Test 14] Cleanup');
  const remove = await request('DELETE', '/users/test_user_001');
  console.log('  Removed:', remove.data.status);

  console.log('\n========================================');
  console.log('  All Tests Completed!');
  console.log('========================================\n');
}

test().catch(console.error);
