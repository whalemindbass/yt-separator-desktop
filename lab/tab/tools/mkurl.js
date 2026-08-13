// 로컬 파일 경로 → 도구가 받는 q 파라미터 값
const path = require('path');
const abs = path.resolve(process.argv[2]);
const url = 'file:///' + abs.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace('%3A', ':');
process.stdout.write(encodeURIComponent(url));
