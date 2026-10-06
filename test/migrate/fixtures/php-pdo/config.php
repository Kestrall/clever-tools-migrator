<?php
$siteName = "🔗klii.cc"; // Nom du site
$siteMail = "kliicc@proton.me"; // Adresse e-mail du site
$host = 'localhost';    // Hôte de la base de données
$dbname = 'url_shortener';  // Nom de la base de données
$username = 'root';    // Nom d'utilisateur pour MySQL
$password = 'local-secret';    // Mot de passe pour MySQL
// Vérifie le CAPTCHA Cloudflare Turnstile
$cf_token = $_POST['cf-turnstile-response'] ?? '';
$cf_secret = '';
$cf_public_key = '';
$cf_verify_url = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';



try {
    // Connexion à la base de données
    $pdo = new PDO("mysql:host=$host;dbname=$dbname", $username, $password);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec("SET NAMES 'utf8mb4'");

} catch (PDOException $e) {
    die("Could not connect to the database $dbname :" . $e->getMessage());
}
?>
