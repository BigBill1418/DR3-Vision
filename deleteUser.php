<?php

    if (isset($_GET["id"])){
        $id = $_GET["id"];
        include "connection.php";
        $sql = "DELETE FROM users WHERE id = $id";
        $con->query($sql);
    }

header("location: viewUsers.php");
exit;

?>

