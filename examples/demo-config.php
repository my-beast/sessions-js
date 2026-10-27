<?php

declare(strict_types=1);

/*
 * The demo page's host server, local only: what a host's backend hands its page - the service's URL, the project's
 * public key and a client token for a made-up person who said yes just now. It borrows services/ (../../../services,
 * where Sessions is a module) to read the "asuvaan" project's Sessions keys, then signs the token with
 * mybeast/sessions-laravel's own signer (../../laravel), exactly as a host would. Served by
 * `php -S 127.0.0.1:8008 -t js`.
 */

if (! in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1', '::1'], true)) {
    http_response_code(403);
    exit;
}

$service = dirname(__DIR__, 3).'/services';

require $service.'/vendor/autoload.php';
require dirname(__DIR__, 2).'/laravel/vendor/autoload.php';

$app = require $service.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Projects\Enums\KeyKind;
use App\Projects\Models\Project;
use App\Projects\Models\ProjectKey;
use App\Projects\Support\KeyMaterial;
use App\Support\Crypto\MasterKey;
use MyBeast\Sessions\Laravel\Tokens\ClientTokenClaims;
use MyBeast\Sessions\Laravel\Tokens\SigningKey;
use MyBeast\Sessions\Laravel\Tokens\TokenSigner;

$project = Project::query()->where('slug', 'asuvaan')->firstOrFail();
$key = fn (KeyKind $kind): ProjectKey => ProjectKey::withoutProjectScope()->where('project_id', $project->id)
    ->where('module', 'sessions')->where('kind', $kind)->whereNull('revoked_at')->latest()->firstOrFail();
$public = $key(KeyKind::PUBLIC)->public_id;
$signing = $key(KeyKind::SIGNING);
$composed = app(MasterKey::class)->open((string) $signing->secret_sealed, KeyMaterial::sealContext($project->id, $signing->public_id));

$now = time();
$mask = ($_GET['mask'] ?? '1') !== '0';
$claims = new ClientTokenClaims(
    subject: 'demo-person',
    account: 'demo-account',
    environment: 'local',
    record: ($_GET['rec'] ?? '1') !== '0',
    mask: $mask,
    // The yes was said a minute ago (the service refuses chunks from before it).
    consentAt: ($_GET['rec'] ?? '1') !== '0' ? ($now - 60) * 1000 : null,
    internal: true,
    test: true,
    issuedAt: $now,
    expiresAt: $now + 1800,
);

header('Content-Type: application/json');
header('Cache-Control: no-store');
echo json_encode([
    'url' => rtrim((string) config('app.url'), '/').'/sessions',
    'key' => $public,
    'env' => 'local',
    'token' => (new TokenSigner(SigningKey::parse($composed), $public))->sign($claims),
], JSON_UNESCAPED_SLASHES);
