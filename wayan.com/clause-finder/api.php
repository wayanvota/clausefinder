<?php
declare(strict_types=1);

$allowed = [
    '/health' => true,
    '/api/meta' => true,
    '/api/coverage' => true,
    '/api/clarify' => true,
    '/api/search' => true,
];

$path = $_GET['path'] ?? '';
if (!isset($allowed[$path])) {
    http_response_code(404);
    header('content-type: application/json; charset=utf-8');
    echo json_encode(['error' => 'Proxy path not allowed']);
    exit;
}

$target = 'https://clausefinder-api.onrender.com' . $path;
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$body = file_get_contents('php://input') ?: '';

header('content-type: application/json; charset=utf-8');

if (function_exists('curl_init')) {
    $ch = curl_init($target);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => ['content-type: application/json'],
        CURLOPT_TIMEOUT => 30,
        CURLOPT_CONNECTTIMEOUT => 10,
    ]);
    if ($method !== 'GET' && $body !== '') {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }
    $response = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);

    if ($response === false) {
        http_response_code(502);
        echo json_encode(['error' => 'Backend proxy failed', 'detail' => $error]);
        exit;
    }

    http_response_code($status > 0 ? $status : 200);
    echo $response;
    exit;
}

$context = stream_context_create([
    'http' => [
        'method' => $method,
        'header' => "content-type: application/json\r\n",
        'content' => $method === 'GET' ? '' : $body,
        'timeout' => 30,
    ],
]);

$response = file_get_contents($target, false, $context);
if ($response === false) {
    http_response_code(502);
    echo json_encode(['error' => 'Backend proxy failed']);
    exit;
}

http_response_code(200);
echo $response;
